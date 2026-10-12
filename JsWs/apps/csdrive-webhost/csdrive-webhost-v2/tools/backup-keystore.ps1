<#
.SYNOPSIS
  Backs up this project's Android release keystore to a second location, only when it has actually changed.

.DESCRIPTION
  Copies docs/private/android-release.keystore, under its own file name, into the folder named in
  docs/private/keystore-backup-location.txt (the first non-comment, non-blank line - see
  docs/private-template/keystore-backup-location.txt for the exact format). The destination is always a
  folder, created if it doesn't exist yet - never a specific file name, which would have been ambiguous for a
  folder that doesn't exist yet with no trailing slash to tell it apart from a file path (caught live: the
  very first test, using this script's own template placeholder verbatim, silently created a same-sized file
  with no extension instead of a folder). Both the keystore and the location file live under docs/private,
  which docs/.gitignore excludes as a whole folder, so neither is ever committed.

  Compares the source and the existing backup by content hash, not by date or size, so a copy that happens to
  share a timestamp (or a coincidentally-same-size unrelated file) is never mistaken for being up to date, and
  a backup that's missing or genuinely stale is always caught. Safe to run as often as you like, by hand or
  from a scheduled task - a run that finds nothing to do changes nothing and says so.

.EXAMPLE
  .\tools\backup-keystore.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$keystorePath = Join-Path $repoRoot 'docs\private\android-release.keystore'
$locationFile = Join-Path $repoRoot 'docs\private\keystore-backup-location.txt'

if (-not (Test-Path $keystorePath -PathType Leaf)) {
    Write-Error "No keystore found at $keystorePath - nothing to back up. See docs/build-and-install.md's own Release signing section if this machine hasn't set one up yet."
}

if (-not (Test-Path $locationFile -PathType Leaf)) {
    Write-Host "No backup location set yet." -ForegroundColor Yellow
    Write-Host "Copy docs\private-template\keystore-backup-location.txt to $locationFile and put the real destination on its own line (not a comment), then run this again."
    exit 1
}

# The first line that isn't blank and doesn't start with '#' - everything else in the file is a comment.
$destRaw = (Get-Content $locationFile | Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') } | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($destRaw)) {
    Write-Error "$locationFile has no real destination in it - every line is blank or a comment. Put the backup destination's own path on its own line."
}
$destRaw = $destRaw.Trim()
$destFolder = $destRaw.TrimEnd('\', '/')
$destPath = Join-Path $destFolder (Split-Path -Leaf $keystorePath)

if (-not (Test-Path $destFolder -PathType Container)) {
    New-Item -ItemType Directory -Path $destFolder -Force | Out-Null
    Write-Host "Created $destFolder"
}

$sourceHash = (Get-FileHash -Path $keystorePath -Algorithm SHA256).Hash
$upToDate = (Test-Path $destPath -PathType Leaf) -and ((Get-FileHash -Path $destPath -Algorithm SHA256).Hash -eq $sourceHash)

if ($upToDate) {
    Write-Host "Already up to date: $destPath matches $keystorePath." -ForegroundColor Green
} else {
    Copy-Item -Path $keystorePath -Destination $destPath -Force
    Write-Host "Backed up: $keystorePath -> $destPath" -ForegroundColor Green
}
