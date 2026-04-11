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

var marginTopOption = new Option<double?>(
    aliases: ["--margin-top", "--mt"],
    description: "Top page margin in centimeters (applies when input is HTML).");

var marginBottomOption = new Option<double?>(
    aliases: ["--margin-bottom", "--mb"],
    description: "Bottom page margin in centimeters (applies when input is HTML).");

var marginLeftOption = new Option<double?>(
    aliases: ["--margin-left", "--ml"],
    description: "Left page margin in centimeters (applies when input is HTML).");

var marginRightOption = new Option<double?>(
    aliases: ["--margin-right", "--mr"],
    description: "Right page margin in centimeters (applies when input is HTML).");

var rootCommand = new RootCommand("Ayran Docs Converter — converts HTML ↔ ODT/PDF")
{
    inputOption,
    outputOption,
    libreOfficeOption,
    browserOption,
    marginTopOption,
    marginBottomOption,
    marginLeftOption,
    marginRightOption
};

rootCommand.SetHandler(async (
    FileInfo input,
    string output,
    string? libreOfficePath,
    string? browserPath,
    double? marginTop,
    double? marginBottom,
    double? marginLeft,
    double? marginRight) =>
{
    if (!input.Exists)
    {
        Console.Error.WriteLine($"Input file not found: {input.FullName}");
        Environment.Exit(1);
    }

    var outputFile = new FileInfo(output);
    var margins = new PageMargins(marginTop, marginBottom, marginLeft, marginRight);
    var converter = new DocumentConverter(libreOfficePath, browserPath);

    try
    {
        await converter.ConvertAsync(input, outputFile, margins);
        Console.WriteLine($"Converted: {input.FullName} -> {outputFile.FullName}");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Conversion failed: {ex.Message}");
        Environment.Exit(1);
    }
},
inputOption, outputOption, libreOfficeOption, browserOption,
marginTopOption, marginBottomOption, marginLeftOption, marginRightOption);

return await rootCommand.InvokeAsync(args);
