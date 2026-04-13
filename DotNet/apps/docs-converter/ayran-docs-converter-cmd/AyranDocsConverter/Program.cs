using System.CommandLine;
using System.Text.Json;
using AyranDocsConverter;

var inputOption = new Option<string>(
    aliases: ["--input", "-i"],
    description: "Path to the input file (HTML, ODT, or PDF), or :baseUrlId:relativePath to fetch HTML from a configured URL.")
{
    IsRequired = true
};

var outputOption = new Option<string>(
    aliases: ["--output", "-o"],
    description: "Path to the output file. The extension determines the output format (.html, .odt, .pdf).")
{
    IsRequired = true
};

var libreOfficeOption = new Option<string>(
    aliases: ["--libreoffice", "-l"],
    description: "Path to the LibreOffice executable (soffice). Auto-detected if not specified.");

var browserOption = new Option<string>(
    aliases: ["--browser", "-b"],
    description: "Path to Chrome or Edge executable used for HTML→PDF. Auto-detected if not specified.");

var rootCommand = new RootCommand("Ayran Docs Converter — converts HTML ↔ ODT/PDF")
{
    inputOption,
    outputOption,
    libreOfficeOption,
    browserOption
};

rootCommand.SetHandler(async (
    string input,
    string output,
    string? libreOfficePath,
    string? browserPath) =>
{
    var outputFile = new FileInfo(output);
    var converter = new DocumentConverter(libreOfficePath, browserPath);

    try
    {
        if (input.StartsWith(':'))
        {
            int secondColon = input.IndexOf(':', 1);
            if (secondColon < 0)
            {
                Console.Error.WriteLine("Invalid input format. Expected :baseUrlId:relativePath");
                Environment.Exit(1);
                return;
            }

            string urlId = input[1..secondColon];
            string relativePath = input[(secondColon + 1)..];

            var (baseUrl, windowsAuth) = GetBaseUrl(urlId);
            string fullUrl = baseUrl.TrimEnd('/') + "/" + relativePath.TrimStart('/');

            await converter.ConvertUrlAsync(fullUrl, outputFile, windowsAuth);
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
inputOption, outputOption, libreOfficeOption, browserOption);

return await rootCommand.InvokeAsync(args);

static (string Url, bool WindowsAuth) GetBaseUrl(string urlId)
{
    string settingsPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");

    if (!File.Exists(settingsPath))
        throw new FileNotFoundException($"appsettings.json not found at: {settingsPath}");

    using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));

    if (!doc.RootElement.TryGetProperty("BaseUrls", out var baseUrls))
        throw new KeyNotFoundException("appsettings.json is missing the 'BaseUrls' section.");

    if (!baseUrls.TryGetProperty(urlId, out var entry))
        throw new KeyNotFoundException($"No base URL configured for identifier '{urlId}' in appsettings.json.");

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

