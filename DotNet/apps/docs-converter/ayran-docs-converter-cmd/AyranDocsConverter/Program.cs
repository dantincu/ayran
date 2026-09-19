using System.CommandLine;
using System.Text.Json;
using System.Text.RegularExpressions;
using AyranDocsConverter;

var inputOption = new Option<string>(
    aliases: ["--input", "-i"],
    description: "Path to the input file (HTML, ODT, or PDF), or :baseUrlId[:relativePath] to fetch HTML from a configured URL.")
{
    IsRequired = true
};

var outputOption = new Option<string>(
    aliases: ["--output", "-o"],
    description: "Path to the output file. The extension determines the output format (.html, .odt, .pdf). " +
        "Give just an extension (e.g. pdf or .pdf) to write next to the input file, with the same name.")
{
    IsRequired = true
};

var libreOfficeOption = new Option<string>(
    aliases: ["--libreoffice", "-l"],
    description: "Path to the LibreOffice executable (soffice). Auto-detected if not specified.");

var browserOption = new Option<string>(
    aliases: ["--browser", "-b"],
    description: "Path to Chrome or Edge executable used for HTML→PDF. Auto-detected if not specified.");

var postOption = new Option<FileInfo?>(
    aliases: ["--post", "-p"],
    description: "Path to a file whose text content is sent as the POST body when fetching from a URL. Only used with URL inputs.");

var rootCommand = new RootCommand("Ayran Docs Converter — converts HTML ↔ ODT/PDF")
{
    inputOption,
    outputOption,
    libreOfficeOption,
    browserOption,
    postOption
};

rootCommand.SetHandler(async (
    string input,
    string output,
    string? libreOfficePath,
    string? browserPath,
    FileInfo? postFile) =>
{
    var converter = new DocumentConverter(libreOfficePath, browserPath);

    try
    {
        if (input.StartsWith(':'))
        {
            if (IsExtensionOnly(output))
            {
                Console.Error.WriteLine(
                    $"Output '{output}' is only an extension, which needs an input file to take the name from. " +
                    "Give a file path for URL inputs.");
                Environment.Exit(1);
                return;
            }

            var outputFile = new FileInfo(output);

            int secondColon = input.IndexOf(':', 1);

            string urlId = secondColon >= 0 ? input[1..secondColon] : input[1..];
            string relativePath = secondColon >= 0 ? input[(secondColon + 1)..] : string.Empty;

            var (baseUrl, windowsAuth) = GetBaseUrl(urlId);
            string fullUrl = baseUrl + relativePath;

            string? postBody = null;
            if (postFile != null)
            {
                if (!postFile.Exists)
                {
                    Console.Error.WriteLine($"POST body file not found: {postFile.FullName}");
                    Environment.Exit(1);
                    return;
                }
                postBody = await File.ReadAllTextAsync(postFile.FullName);
            }

            await converter.ConvertUrlAsync(fullUrl, outputFile, windowsAuth, postBody);
            Console.WriteLine($"Converted: {fullUrl} -> {outputFile.FullName}");
        }
        else
        {
            var inputFile = new FileInfo(input);
            if (!inputFile.Exists)
            {
                Console.Error.WriteLine($"Input file not found: {inputFile.FullName}");
                Environment.Exit(1);
                return;
            }

            var outputFile = new FileInfo(IsExtensionOnly(output)
                ? Path.ChangeExtension(inputFile.FullName, output.TrimStart('.'))
                : output);

            await converter.ConvertAsync(inputFile, outputFile);
            Console.WriteLine($"Converted: {inputFile.FullName} -> {outputFile.FullName}");
        }
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Conversion failed: {ex.Message}");
        Environment.Exit(1);
    }
},
inputOption, outputOption, libreOfficeOption, browserOption, postOption);

return await rootCommand.InvokeAsync(args);

static bool IsExtensionOnly(string output) =>
    Regex.IsMatch(output, @"^\.?[A-Za-z0-9]+$");

static (string Url, bool WindowsAuth) GetBaseUrl(string urlId)
{
    string settingsPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");

    if (!File.Exists(settingsPath))
        throw new FileNotFoundException($"appsettings.json not found at: {settingsPath}");

    using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));
    var root = doc.RootElement;

    bool globalIsProd = root.TryGetProperty("IsProd", out var globalIsProdProp) &&
        globalIsProdProp.ValueKind == JsonValueKind.True;

    if (!root.TryGetProperty("BaseUrls", out var baseUrls))
        throw new KeyNotFoundException("appsettings.json is missing the 'BaseUrls' section.");

    if (!baseUrls.TryGetProperty(urlId, out var entry))
        throw new KeyNotFoundException($"No base URL configured for identifier '{urlId}' in appsettings.json.");

    if (globalIsProd)
    {
        bool entryIsProd = entry.TryGetProperty("IsProd", out var entryIsProdProp) &&
            entryIsProdProp.ValueKind == JsonValueKind.True;

        if (!entryIsProd)
            throw new InvalidOperationException(
                $"URL identifier '{urlId}' is not allowed in production mode (IsProd is not true for this entry).");
    }

    string url = entry.GetProperty("Url").GetString()
        ?? throw new InvalidOperationException($"'Url' for '{urlId}' is null in appsettings.json.");

    bool? explicitAuth = entry.TryGetProperty("WindowsAuth", out var authProp) && authProp.ValueKind != JsonValueKind.Null
        ? authProp.GetBoolean()
        : null;

    bool windowsAuth = explicitAuth ?? IsLocalhost(url);
    return (url, windowsAuth);
}

static bool IsLocalhost(string url)
{
    if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
    {
        string host = uri.Host.ToLowerInvariant();
        return host is "localhost" or "127.0.0.1" or "::1";
    }
    return false;
}

