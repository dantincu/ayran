# Find And Replace File

This app will take the following input arguments:
 - `-s` or `--source`: the path of the source file
 - `-d` or `--destination`: the path of the destination directory
 - (optional) `-n` or `--name`: the file name (its default value will be the name of the file at path found in the `--source` argument)
 - (optional) `-nx` or `-name-x`: just like `--name` but represents a regex; will be ignored if `--name` was explicitly given

And will do the following: first it will read the contents of the file at the path found in the `--source` argument. Then traverse the directory at path found in the `--destination` argument recursively (infinite depth) and for every existing file whose name equals to that found in argument `--name` (or matches the regex from the argument `--name-x`, if given instead of `--name`), it opens the existing file and replaces all of its contents with the contents that had been copied from the source file at the start of the execution.

This app should be created in .NET Core.