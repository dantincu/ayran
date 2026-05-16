const TEXT_EXTS = new Set([
  'txt','md','json','js','ts','tsx','jsx','css','html','htm','xml','csv',
  'yaml','yml','rs','py','go','java','c','cpp','h','sh','bash','sql',
  'toml','ini','cfg','env','log','gitignore','editorconfig',
]);

export function isTextFile(name: string, mimeType?: string | null): boolean {
  const mime = mimeType ?? '';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return true;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTS.has(ext);
}
