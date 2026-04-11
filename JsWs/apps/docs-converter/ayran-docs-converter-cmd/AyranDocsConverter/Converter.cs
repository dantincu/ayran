using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace AyranDocsConverter;

/// <summary>Page margins in centimeters. Null means "use document/browser default".</summary>
public record PageMargins(
    double? Top = null,
    double? Bottom = null,
    double? Left = null,
    double? Right = null)
{
    public bool HasAny => Top.HasValue || Bottom.HasValue || Left.HasValue || Right.HasValue;

    /// <summary>Builds a CSS @page rule string, e.g. "@page { margin: 2cm 1.5cm 2cm 1.5cm; }".</summary>
    public string ToCssPageRule()
    {
        static string Cm(double? v, double fallback) =>
            (v ?? fallback).ToString("0.##", CultureInfo.InvariantCulture) + "cm";

        // Use the opposite edge as fallback so unspecified sides get a sensible value
        string top = Cm(Top, Bottom ?? 2.0);
        string bottom = Cm(Bottom, Top ?? 2.0);
        string left = Cm(Left, Right ?? 2.0);
        string right = Cm(Right, Left ?? 2.0);

        return $"@page {{ margin: {top} {right} {bottom} {left}; }}";
    }
}

public class DocumentConverter(string? libreOfficePath = null, string? chromiumPath = null)
{
    private static readonly string[] HtmlExtensions = [".html", ".htm"];
    private static readonly string[] OdtExtensions = [".odt"];
    private static readonly string[] PdfExtensions = [".pdf"];

    public async Task ConvertAsync(FileInfo input, FileInfo output, PageMargins? margins = null)
    {
        string inputExt = input.Extension.ToLowerInvariant();
        string outputExt = output.Extension.ToLowerInvariant();

        bool inputIsHtml = HtmlExtensions.Contains(inputExt);
        bool inputIsOdt = OdtExtensions.Contains(inputExt);
        bool inputIsPdf = PdfExtensions.Contains(inputExt);

        bool outputIsHtml = HtmlExtensions.Contains(outputExt);
        bool outputIsOdt = OdtExtensions.Contains(outputExt);
        bool outputIsPdf = PdfExtensions.Contains(outputExt);

        if (!inputIsHtml && !inputIsOdt && !inputIsPdf)
            throw new NotSupportedException($"Unsupported input format: {inputExt}. Supported: .html, .htm, .odt, .pdf");

        if (!outputIsHtml && !outputIsOdt && !outputIsPdf)
            throw new NotSupportedException($"Unsupported output format: {outputExt}. Supported: .html, .htm, .odt, .pdf");

        if (inputIsHtml && outputIsHtml || inputIsOdt && outputIsOdt || inputIsPdf && outputIsPdf)
            throw new InvalidOperationException("Input and output formats are the same.");

        // HTML → PDF: use a real browser (Chrome/Edge) for accurate CSS rendering,
        // falling back to LibreOffice if no browser is found.
        if (inputIsHtml && outputIsPdf)
        {
            await ConvertHtmlToPdfAsync(input, output, margins);
            return;
        }

        // PDF → HTML: pdftohtml (poppler) or LibreOffice fallback
        if (inputIsPdf && outputIsHtml)
        {
            await ConvertPdfToHtmlAsync(input, output);
            return;
        }

        // HTML → ODT: preprocess for LibreOffice compat, then convert
        if (inputIsHtml)
        {
            await ConvertHtmlViaLibreOfficeAsync(input, output, outputExt.TrimStart('.'), margins);
            return;
        }

        // ODT/PDF → ODT/HTML: straight LibreOffice
        await ConvertViaLibreOfficeAsync(input, output, outputExt.TrimStart('.'));
    }

    // -------------------------------------------------------------------------
    // HTML → PDF via Chrome/Edge headless
    // -------------------------------------------------------------------------

    private async Task ConvertHtmlToPdfAsync(FileInfo input, FileInfo output, PageMargins? margins)
    {
        string? browser = chromiumPath ?? FindChromiumExecutable();

        if (browser != null)
        {
            await ConvertHtmlToPdfViaChromiumAsync(browser, input, output, margins);
        }
        else
        {
            // No browser found — fall back to LibreOffice (limited rendering)
            Console.Error.WriteLine(
                "Warning: no Chrome/Edge found for HTML→PDF. " +
                "Falling back to LibreOffice (may not render all content correctly). " +
                "Install Chrome or Edge, or pass --browser <path>.");
            await ConvertHtmlViaLibreOfficeAsync(input, output, "pdf", margins);
        }
    }

    private static async Task ConvertHtmlToPdfViaChromiumAsync(
        string browserPath, FileInfo input, FileInfo output, PageMargins? margins)
    {
        // If margins are specified, inject @page CSS into a temp file alongside the original
        // (same directory so relative image paths keep working)
        string? tempPath = null;
        string inputPath = input.FullName;

        if (margins is { HasAny: true })
        {
            tempPath = Path.Combine(
                input.DirectoryName!,
                $"ayran_{Path.GetFileNameWithoutExtension(input.Name)}_{Guid.NewGuid():N}{input.Extension}");

            string html = await File.ReadAllTextAsync(input.FullName);
            await File.WriteAllTextAsync(tempPath, InjectCssBlock(html, margins.ToCssPageRule()));
            inputPath = tempPath;
        }

        try
        {
            Directory.CreateDirectory(output.DirectoryName ?? ".");

            // Chrome/Edge require a file:// URL; use forward slashes
            string fileUrl = "file:///" + inputPath.Replace('\\', '/');

            // --no-pdf-header-footer removes the default URL/date/page-number decoration
            string arguments =
                $"--headless --disable-gpu --no-pdf-header-footer " +
                $"--print-to-pdf=\"{output.FullName}\" \"{fileUrl}\"";

            await RunProcessAsync(browserPath, arguments);
        }
        finally
        {
            if (tempPath != null && File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    private static string? FindChromiumExecutable()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            string[] candidates =
            [
                // Edge (built into Windows 10/11)
                Path.Combine(pfx86, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf,    @"Microsoft\Edge\Application\msedge.exe"),
                // Chrome (system-wide)
                Path.Combine(pf,    @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pfx86, @"Google\Chrome\Application\chrome.exe"),
                // Chrome (per-user)
                Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
            ];

            foreach (string c in candidates)
                if (File.Exists(c)) return c;
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            string[] candidates =
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ];

            foreach (string c in candidates)
                if (File.Exists(c)) return c;
        }

        // Linux / fallback: check PATH
        foreach (string name in new[] { "google-chrome", "chromium-browser", "chromium", "microsoft-edge" })
        {
            string? found = FindExecutable(name);
            if (found != null) return found;
        }

        return null;
    }

    // -------------------------------------------------------------------------
    // HTML → ODT via LibreOffice (with compat CSS preprocessing)
    // -------------------------------------------------------------------------

    private async Task ConvertHtmlViaLibreOfficeAsync(
        FileInfo input, FileInfo output, string targetFormat, PageMargins? margins)
    {
        /* string tempPath = Path.Combine(
            input.DirectoryName!,
            $"ayran_{Path.GetFileNameWithoutExtension(input.Name)}_{Guid.NewGuid():N}{input.Extension}");

        try
        {
            string html = await File.ReadAllTextAsync(input.FullName);
            string patched = PatchHtmlForLibreOffice(html, margins);
            await File.WriteAllTextAsync(tempPath, patched);

            await ConvertViaLibreOfficeAsync(new FileInfo(tempPath), output, targetFormat);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        } */

        await ConvertViaLibreOfficeAsync(input, output, targetFormat);
    }

    /// <summary>
    /// Injects LibreOffice compatibility CSS (block layout overrides) and an optional
    /// @page margin rule, because LibreOffice's HTML renderer does not support flex/grid.
    /// </summary>
    private static string PatchHtmlForLibreOffice(string html, PageMargins? margins)
    {
        const string compatCss = "";
        /* "body,div,section,article,main,header,footer,nav,aside { display: block; }\n" +
        "  img { display: block; max-width: 100%; height: auto; }"; */

        string injected = margins is { HasAny: true }
            ? $"{compatCss}\n  {margins.ToCssPageRule()}"
            : compatCss;

        return InjectCssBlock(html, injected);
    }

    // -------------------------------------------------------------------------
    // PDF → HTML
    // -------------------------------------------------------------------------

    private static async Task ConvertPdfToHtmlAsync(FileInfo input, FileInfo output)
    {
        string? pdfToHtml = FindExecutable("pdftohtml");
        if (pdfToHtml != null)
        {
            Directory.CreateDirectory(output.DirectoryName ?? ".");
            string tempStem = Path.Combine(
                output.DirectoryName!,
                Path.GetFileNameWithoutExtension(output.Name) + "_tmp");

            await RunProcessAsync(pdfToHtml, $"-noframes \"{input.FullName}\" \"{tempStem}\"");

            string produced = tempStem + ".html";
            if (!File.Exists(produced))
                throw new FileNotFoundException($"pdftohtml did not produce expected output: {produced}");

            if (output.Exists) output.Delete();
            File.Move(produced, output.FullName);
        }
        else
        {
            // Fall back to LibreOffice (limited PDF→HTML quality)
            await new DocumentConverter().ConvertViaLibreOfficeAsync(input, output, "html");
        }
    }

    // -------------------------------------------------------------------------
    // LibreOffice generic converter
    // -------------------------------------------------------------------------

    private async Task ConvertViaLibreOfficeAsync(FileInfo input, FileInfo output, string targetFormat)
    {
        string outDir = output.DirectoryName ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outDir);

        string sofficePath = libreOfficePath ?? FindLibreOffice();

        string filterArg = targetFormat switch
        {
            "html" or "htm" => "html",
            "odt" => "odt",
            "pdf" => "pdf",
            _ => targetFormat
        };

        string arguments = $"--headless --convert-to {filterArg} --outdir \"{outDir}\" \"{input.FullName}\"";
        await RunProcessAsync(sofficePath, arguments);

        // LibreOffice names the output based on the input filename
        string expectedName = Path.ChangeExtension(input.Name, filterArg == "html" ? "html" : filterArg);
        string expectedPath = Path.Combine(outDir, expectedName);

        if (!File.Exists(expectedPath))
            throw new FileNotFoundException($"LibreOffice did not produce expected output file: {expectedPath}");

        if (!string.Equals(expectedPath, output.FullName, StringComparison.OrdinalIgnoreCase))
        {
            if (output.Exists) output.Delete();
            File.Move(expectedPath, output.FullName);
        }
    }

    private static string FindLibreOffice()
    {
        string? fromPath = FindExecutable("soffice");
        if (fromPath != null) return fromPath;

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            string[] candidates =
            [
                @"C:\Program Files\LibreOffice\program\soffice.exe",
                @"C:\Program Files (x86)\LibreOffice\program\soffice.exe"
            ];
            foreach (string c in candidates)
                if (File.Exists(c)) return c;
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            string macPath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
            if (File.Exists(macPath)) return macPath;
        }
        else
        {
            string? lo = FindExecutable("libreoffice");
            if (lo != null) return lo;
        }

        throw new FileNotFoundException(
            "LibreOffice (soffice) not found. Install LibreOffice or specify its path with --libreoffice.");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// <summary>Inserts <paramref name="css"/> into the first &lt;style&gt; block, or prepends one.</summary>
    private static string InjectCssBlock(string html, string css)
    {
        int styleOpen = html.IndexOf("<style", StringComparison.OrdinalIgnoreCase);
        if (styleOpen >= 0)
        {
            int styleClose = html.IndexOf('>', styleOpen);
            if (styleClose >= 0)
                return html.Insert(styleClose + 1, $"\n  {css}\n");
        }

        return $"<style>\n  {css}\n</style>\n" + html;
    }

    private static async Task RunProcessAsync(string executable, string arguments)
    {
        var psi = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = arguments,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start process: {executable}");

        string stdout = await process.StandardOutput.ReadToEndAsync();
        string stderr = await process.StandardError.ReadToEndAsync();

        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"Process exited with code {process.ExitCode}.\nstdout: {stdout}\nstderr: {stderr}");
    }

    private static string? FindExecutable(string name)
    {
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        string[] dirs = pathVar.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);

        string[] exeExtensions = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? [".exe", ".cmd", ".bat"]
            : [""];

        foreach (string dir in dirs)
        {
            foreach (string ext in exeExtensions)
            {
                string candidate = Path.Combine(dir, name + ext);
                if (File.Exists(candidate)) return candidate;
            }
        }

        return null;
    }
}
