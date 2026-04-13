using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AyranDocsConverter;

public class DocumentConverter(string? libreOfficePath = null, string? chromiumPath = null)
{
    private static readonly string[] HtmlExtensions = [".html", ".htm"];
    private static readonly string[] PdfExtensions  = [".pdf"];

    private static readonly string[] AllInputExtensions  = [".html", ".htm", ".odt", ".doc", ".docx", ".pdf"];
    private static readonly string[] AllOutputExtensions = [".html", ".htm", ".odt", ".doc", ".docx", ".pdf"];

    public async Task ConvertUrlAsync(string url, FileInfo output, bool useWindowsAuth = false, string? postBody = null)
    {
        string outputExt = output.Extension.ToLowerInvariant();

        if (outputExt is ".html" or ".htm")
        {
            string html = await FetchHtmlAsync(url, useWindowsAuth, postBody);
            Directory.CreateDirectory(output.DirectoryName ?? ".");
            await File.WriteAllTextAsync(output.FullName, html);
            return;
        }

        if (PdfExtensions.Contains(outputExt))
        {
            await ConvertUrlToPdfAsync(url, libreOfficeInput: null, output);
            return;
        }

        // All other formats (odt, doc, docx, …): fetch HTML, write temp file, convert via LibreOffice.
        string tempFile = Path.Combine(Path.GetTempPath(), $"ayran-input-{Guid.NewGuid()}.html");
        try
        {
            string html = await FetchHtmlAsync(url, useWindowsAuth, postBody);
            await File.WriteAllTextAsync(tempFile, html);
            await ConvertViaLibreOfficeAsync(new FileInfo(tempFile), output,
                outputExt.TrimStart('.'));
        }
        finally
        {
            if (File.Exists(tempFile)) File.Delete(tempFile);
        }
    }

    public async Task ConvertAsync(FileInfo input, FileInfo output)
    {
        string inputExt  = input.Extension.ToLowerInvariant();
        string outputExt = output.Extension.ToLowerInvariant();

        if (!AllInputExtensions.Contains(inputExt))
            throw new NotSupportedException($"Unsupported input format: {inputExt}. Supported: {string.Join(", ", AllInputExtensions)}");

        if (!AllOutputExtensions.Contains(outputExt))
            throw new NotSupportedException($"Unsupported output format: {outputExt}. Supported: {string.Join(", ", AllOutputExtensions)}");

        if (inputExt == outputExt)
            throw new InvalidOperationException("Input and output formats are the same.");

        bool inputIsHtml  = HtmlExtensions.Contains(inputExt);
        bool inputIsPdf   = PdfExtensions.Contains(inputExt);
        bool outputIsPdf  = PdfExtensions.Contains(outputExt);
        bool outputIsHtml = HtmlExtensions.Contains(outputExt);

        if (inputIsHtml && outputIsPdf)
        {
            await ConvertHtmlToPdfAsync(input, output);
            return;
        }

        if (inputIsPdf && outputIsHtml)
        {
            await ConvertPdfToHtmlAsync(input, output);
            return;
        }

        await ConvertViaLibreOfficeAsync(input, output, outputExt.TrimStart('.'));
    }

    // -------------------------------------------------------------------------
    // HTML → PDF via Chrome/Edge headless
    // -------------------------------------------------------------------------

    private async Task ConvertHtmlToPdfAsync(FileInfo input, FileInfo output)
    {
        string inputUrl = "file:///" + input.FullName.Replace('\\', '/');
        await ConvertUrlToPdfAsync(inputUrl, input, output);
    }

    private async Task ConvertUrlToPdfAsync(string inputUrl, FileInfo? libreOfficeInput, FileInfo output)
    {
        string? browser = chromiumPath ?? FindChromiumExecutable();

        if (browser != null)
        {
            Directory.CreateDirectory(output.DirectoryName ?? ".");
            string arguments =
                $"--headless --disable-gpu --no-pdf-header-footer " +
                $"--print-to-pdf=\"{output.FullName}\" \"{inputUrl}\"";
            await RunProcessAsync(browser, arguments);
        }
        else
        {
            Console.Error.WriteLine(
                "Warning: no Chrome/Edge found for HTML→PDF. " +
                "Falling back to LibreOffice (may not render all content correctly). " +
                "Install Chrome or Edge, or pass --browser <path>.");

            if (libreOfficeInput == null)
                throw new InvalidOperationException(
                    "LibreOffice fallback requires a local file; no Chrome/Edge found and no local file is available for the URL input.");

            await ConvertViaLibreOfficeAsync(libreOfficeInput, output, "pdf");
        }
    }

    private static string? FindChromiumExecutable()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            string pf    = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            string[] candidates =
            [
                Path.Combine(pfx86, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf,    @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf,    @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pfx86, @"Google\Chrome\Application\chrome.exe"),
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

        foreach (string name in new[] { "google-chrome", "chromium-browser", "chromium", "microsoft-edge" })
        {
            string? found = FindExecutable(name);
            if (found != null) return found;
        }

        return null;
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
            "odt"           => "odt",
            "doc"           => "doc",
            "docx"          => "docx",
            "pdf"           => "pdf",
            _               => targetFormat
        };

        // Use an isolated user profile so headless mode doesn't conflict with a running
        // LibreOffice GUI instance (which locks the default profile and causes silent failure).
        string profileDir = Path.Combine(Path.GetTempPath(), "ayran-lo-profile");
        string profileUri = "file:///" + profileDir.Replace('\\', '/');

        // Without --infilter, LibreOffice routes HTML and PDF through the Draw importer,
        // which cannot export to Writer formats (odt/doc/docx). Force the correct importer.
        string inputExt = input.Extension.ToLowerInvariant();
        string infilter = filterArg is "odt" or "doc" or "docx"
            ? HtmlExtensions.Contains(inputExt)
                ? "--infilter=\"HTML (StarWriter)\" "
                : PdfExtensions.Contains(inputExt)
                    ? "--infilter=\"writer_pdf_import\" "
                    : ""
            : "";

        string arguments =
            $"--headless --norestore \"-env:UserInstallation={profileUri}\" " +
            $"{infilter}--convert-to {filterArg} --outdir \"{outDir}\" \"{input.FullName}\"";

        await RunProcessAsync(sofficePath, arguments);

        // LibreOffice always names its output file after the INPUT filename (not the output path).
        // We locate that intermediate file and rename it to the requested output path.
        string expectedName = Path.ChangeExtension(input.Name, filterArg == "html" ? "html" : filterArg);
        string expectedPath = Path.Combine(outDir, expectedName);

        if (!File.Exists(expectedPath))
            throw new FileNotFoundException(
                $"LibreOffice ran but produced no output file.\n" +
                $"  Intermediate expected at: {expectedPath}\n" +
                $"  Final output path:        {output.FullName}");

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
    // -------------------------------------------------------------------------
    // HTTP helper
    // -------------------------------------------------------------------------

    private static async Task<string> FetchHtmlAsync(string url, bool useWindowsAuth = false, string? postBody = null)
    {
        var handler = new HttpClientHandler { UseDefaultCredentials = useWindowsAuth };
        using var client = new HttpClient(handler);
        client.DefaultRequestHeaders.Add("User-Agent", "AyranDocsConverter/1.0");
        var response = postBody != null
            ? await client.PostAsync(url, new StringContent(postBody))
            : await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    // Helpers
    // -------------------------------------------------------------------------

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
