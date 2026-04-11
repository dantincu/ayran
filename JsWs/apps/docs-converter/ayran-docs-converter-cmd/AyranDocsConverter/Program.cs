using System.CommandLine;
using AyranDocsConverter;

var inputOption = new Option<FileInfo>(
    aliases: ["--input", "-i"],
    description: "Path to the input file (HTML, ODT, or PDF)")
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
    FileInfo input,
    string output,
    string? libreOfficePath,
    string? browserPath) =>
{
    if (!input.Exists)
    {
        Console.Error.WriteLine($"Input file not found: {input.FullName}");
        Environment.Exit(1);
    }

    var outputFile = new FileInfo(output);
    var converter = new DocumentConverter(libreOfficePath, browserPath);

    try
    {
        await converter.ConvertAsync(input, outputFile);
        Console.WriteLine($"Converted: {input.FullName} -> {outputFile.FullName}");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Conversion failed: {ex.Message}");
        Environment.Exit(1);
    }
},
inputOption, outputOption, libreOfficeOption, browserOption);

return await rootCommand.InvokeAsync(args);
