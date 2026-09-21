/** Selects what a person most likely wants to retype when a rename starts, as Total Commander does: the name **without its extension** for a
 * file (`photo` of `photo.jpg`), the whole name for a folder or a name that has no extension. */
export function selectBaseName(input: HTMLInputElement, isDirectory: boolean): void {
  const dot = input.value.lastIndexOf('.')
  input.setSelectionRange(0, !isDirectory && dot > 0 ? dot : input.value.length)
}
