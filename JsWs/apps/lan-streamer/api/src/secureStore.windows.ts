import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Windows DPAPI ties the protected blob to the current Windows user account
// on this machine: CryptUnprotectData derives its key from secrets only the
// OS holds for that user, so the blob can't be decrypted by copying it (plus
// any other file) to a different machine or user account. We shell out to
// PowerShell rather than a native Node addon so the API stays a single
// dependency-free bundle.cjs - no prebuilt .node binaries to ship alongside it.
async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
  return stdout.trim();
}

export async function protect(data: Buffer): Promise<Buffer> {
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${data.toString("base64")}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;
  const out = await runPowerShell(script);
  return Buffer.from(out, "base64");
}

export async function unprotect(data: Buffer): Promise<Buffer> {
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${data.toString("base64")}')
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($unprotected)
`;
  const out = await runPowerShell(script);
  return Buffer.from(out, "base64");
}
