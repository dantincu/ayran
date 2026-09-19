# Ayran Docs Converter

Command-line tool that converts documents between HTML, ODT, DOC, DOCX and PDF.

- **HTML → PDF** is rendered by headless Chrome or Edge (auto-detected, or pass `--browser`).
- Everything else (ODT/DOC/DOCX, PDF → HTML) goes through LibreOffice (`soffice`, auto-detected, or pass `--libreoffice`).
- The input can also be a URL configured in `appsettings.json` (`:baseUrlId[:relativePath]`), optionally with a POST body (`--post`).

## Build

```powershell
dotnet build -c Release
```

The executable is then at `bin\Release\net10.0\AyranDocsConverter.exe`.

## Basic usage

```powershell
AyranDocsConverter.exe --input input.html --output output.pdf
```

The output format is chosen by the extension of `--output`.

To write the output next to the input file, with the same name, give only an extension (`pdf` or `.pdf`):

```powershell
AyranDocsConverter.exe -i C:\docs\input.html -o pdf     # -> C:\docs\input.pdf
```

This works for file inputs only. A URL input (`:baseUrlId`) has no file name to reuse, so it needs a full output path.

## Example: PDF from a list of image paths in a text file

Image lists are turned into HTML by the `DocScanImgs` page of `Turmerik.GenHtml.WebApp` (`C:\A\T\turmerik\DotNet\Turmerik.GenHtml.WebApp`). The page takes the POST body, one image path per line, and returns an HTML document with one `<img>` per line. The converter then prints that HTML to PDF.

Sample data is in [test/imgs](test/imgs): `paths.txt` lists one image per line, relative to the folder it is in.

```text
pic001.jpg
pic002.png
pic003.jpg
pic004.png
```

### 1. Start the web app

The `docScanImgs` entry in [appsettings.json](appsettings.json) points at `https://localhost:7002/DocScanImgs`:

```powershell
cd C:\A\T\turmerik\DotNet\Turmerik.GenHtml.WebApp
dotnet run --no-launch-profile --urls "https://localhost:7002"
```

The ASP.NET dev certificate must be trusted, or the converter fails with "The SSL connection could not be established". To trust it once:

```powershell
dotnet dev-certs https --trust
```

### 2. Convert the list to HTML, then to PDF

From the `AyranDocsConverter` folder:

```powershell
# paths.txt -> HTML (saved next to the images)
.\bin\Release\net10.0\AyranDocsConverter.exe -i :docScanImgs -p test\imgs\paths.txt -o test\imgs\images.html

# HTML -> PDF (test\imgs\images.pdf, next to the HTML)
.\bin\Release\net10.0\AyranDocsConverter.exe -i test\imgs\images.html -o pdf
```

Result: `test\imgs\images.pdf` with the images stacked in the order listed. Each image is scaled down to fit the page width and height and is never enlarged.

Notes:

- **Save the HTML in the folder the image paths are relative to.** The paths are written into the HTML as they are in the list, so `pic001.jpg` is resolved next to `images.html`. That is why the HTML output above goes into `test\imgs`.
- **The two steps cannot be merged into one.** `-i :docScanImgs -p paths.txt -o out.pdf` runs without an error but produces a blank PDF, because for PDF output the POST body is not sent (the browser just does a GET of the page). Generate the HTML first, as above.
- **Production mode.** `appsettings.json` has `"IsProd": true` at the top level, so only URL entries with `"IsProd": true` are allowed. `docScanImgs` is; `docScanImgsTest` (port 7124) is not, until you change that flag.
- For `localhost` URLs the converter sends the current Windows credentials, which the web app requires (Negotiate authentication).

## Options

| Option | Alias | Description |
| --- | --- | --- |
| `--input` | `-i` | Input file (HTML, ODT, DOC, DOCX, PDF), or `:baseUrlId[:relativePath]` to fetch HTML from a URL configured in `appsettings.json`. Required. |
| `--output` | `-o` | Output file; the extension selects the format. Give only an extension (`pdf`, `.pdf`) to write next to the input file with the same name (file inputs only). Required. |
| `--browser` | `-b` | Path to the Chrome/Edge executable used for HTML → PDF. |
| `--libreoffice` | `-l` | Path to the LibreOffice `soffice` executable. |
| `--post` | `-p` | File whose text is sent as the POST body when fetching from a URL. Works for HTML and ODT/DOC/DOCX output, not PDF (see above). |
