using System.CommandLine;
using System.CommandLine.Parsing;
using System.Text.RegularExpressions;

var sourceOption = new Option<string>(
    aliases: ["--source", "-s"],
    description: "Path to the source file whose contents will be copied.")
{
    IsRequired = true
};

var destinationOption = new Option<string>(
    aliases: ["--destination", "-d"],
    description: "Path to the directory that is searched recursively for files to replace.")
{
    IsRequired = true
};

var nameOption = new Option<string?>(
    aliases: ["--name", "-n"],
    description: "File name to look for. Defaults to the name of the source file.");

var nameRegexOption = new Option<string?>(
    aliases: ["--name-x", "-nx"],
    description: "Regex that file names must match. Ignored if --name is given.");

var rootCommand = new RootCommand("Ayran Find And Replace File — replaces the contents of every matching file under a directory with the contents of a source file")
{
    sourceOption,
    destinationOption,
    nameOption,
    nameRegexOption
};

rootCommand.SetHandler(context =>
{
    var parse = context.ParseResult;
    string source = parse.GetValueForOption(sourceOption)!;
    string destination = parse.GetValueForOption(destinationOption)!;
    string? name = parse.GetValueForOption(nameOption);
    string? nameRegex = parse.GetValueForOption(nameRegexOption);

    var sourceFile = new FileInfo(source);
    if (!sourceFile.Exists)
    {
        Console.Error.WriteLine($"Source file not found: {sourceFile.FullName}");
        context.ExitCode = 1;
        return;
    }

    var destinationDir = new DirectoryInfo(destination);
    if (!destinationDir.Exists)
    {
        Console.Error.WriteLine($"Destination directory not found: {destinationDir.FullName}");
        context.ExitCode = 1;
        return;
    }

    Func<string, bool> isMatch;
    if (parse.FindResultFor(nameOption) != null || nameRegex == null)
    {
        string targetName = name ?? sourceFile.Name;
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        isMatch = fileName => string.Equals(fileName, targetName, comparison);
    }
    else
    {
        Regex regex;
        try
        {
            regex = new Regex(nameRegex);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine($"Invalid --name-x regex: {ex.Message}");
            context.ExitCode = 1;
            return;
        }
        isMatch = regex.IsMatch;
    }

    byte[] contents = File.ReadAllBytes(sourceFile.FullName);

    var enumeration = new EnumerationOptions
    {
        RecurseSubdirectories = true,
        IgnoreInaccessible = true,
        // Include hidden/system files; skip symlinks and junctions so link cycles can't recurse forever.
        AttributesToSkip = FileAttributes.ReparsePoint
    };

    int replaced = 0;
    int failed = 0;

    foreach (var file in destinationDir.EnumerateFiles("*", enumeration))
    {
        if (!isMatch(file.Name))
            continue;

        if (string.Equals(file.FullName, sourceFile.FullName, StringComparison.OrdinalIgnoreCase))
            continue;

        try
        {
            File.WriteAllBytes(file.FullName, contents);
            Console.WriteLine($"Replaced: {file.FullName}");
            replaced++;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"Failed: {file.FullName} — {ex.Message}");
            failed++;
        }
    }

    Console.WriteLine($"Done. {replaced} file(s) replaced, {failed} failed.");
    context.ExitCode = failed > 0 ? 1 : 0;
});

return await rootCommand.InvokeAsync(args);
