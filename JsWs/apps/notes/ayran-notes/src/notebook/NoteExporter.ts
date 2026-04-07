import { marked } from 'marked';
import * as Print from 'expo-print';
import { IStorageProvider } from '../types/storage.types';
import { buildHtmlFileName, buildPdfFileName } from './NoteFileNaming';

export interface ExportResult {
  htmlGenerated: boolean;
  pdfGenerated: boolean;
  htmlFilePath: string | null;
  pdfFilePath: string | null;
}

const DEFAULT_CSS = `
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: #24292e;
  background: #fff;
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}
body.dark, html.dark body {
  color: #e1e4e8;
  background: #0d1117;
}
h1, h2, h3, h4, h5, h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
}
code {
  background: rgba(175, 184, 193, 0.2);
  border-radius: 3px;
  padding: 0.2em 0.4em;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 85%;
}
pre code {
  background: none;
  padding: 0;
}
pre {
  background: #f6f8fa;
  border-radius: 6px;
  padding: 1rem;
  overflow: auto;
}
html.dark pre {
  background: #161b22;
}
blockquote {
  border-left: 4px solid #d0d7de;
  padding-left: 1rem;
  margin-left: 0;
  color: #57606a;
}
a { color: #0969da; }
html.dark a { color: #58a6ff; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
th { background: #f6f8fa; }
html.dark th { background: #161b22; }
html.dark th, html.dark td { border-color: #30363d; }
img { max-width: 100%; }
`;

/**
 * Convert markdown content to HTML string.
 */
export async function markdownToHtml(
  content: string,
  darkMode: boolean,
  customCss?: string | null,
): Promise<string> {
  const bodyContent = await marked.parse(content);
  const css = customCss ?? DEFAULT_CSS;
  const themeClass = darkMode ? 'dark' : 'light';

  return `<!DOCTYPE html>
<html class="${themeClass}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/**
 * Determine if markdown content is "only the title" (spec rule for HTML/PDF generation).
 */
export function isContentOnlyTitle(content: string): boolean {
  const trimmed = content.trim();
  return /^#\s+.+$/.test(trimmed);
}

/**
 * Export a note to HTML and PDF files.
 */
export async function exportNote(
  provider: IStorageProvider,
  shortNameFolderPath: string,
  mdFileName: string,
  markdownContent: string,
  darkMode: boolean,
  customCss?: string | null,
): Promise<ExportResult> {
  const htmlFileName = buildHtmlFileName(mdFileName);
  const pdfFileName = buildPdfFileName(mdFileName);
  const htmlFilePath = provider.joinPath(shortNameFolderPath, htmlFileName);
  const pdfFilePath = provider.joinPath(shortNameFolderPath, pdfFileName);
  const onlyTitle = isContentOnlyTitle(markdownContent);

  // Generate HTML
  const htmlContent = await markdownToHtml(markdownContent, darkMode, customCss);

  // Always generate PDF
  let pdfGenerated = false;
  try {
    const { uri: tempPdfUri } = await Print.printToFileAsync({ html: htmlContent });
    const pdfBytes = await readUriAsBytes(tempPdfUri);
    await provider.writeFileBytes(pdfFilePath, pdfBytes);
    pdfGenerated = true;
  } catch (err) {
    console.error('PDF generation failed:', err);
  }

  // Only write HTML if content is more than just the title
  let htmlGenerated = false;
  if (!onlyTitle) {
    await provider.writeFile(htmlFilePath, htmlContent);
    htmlGenerated = true;
  } else {
    // Delete HTML if it exists (spec: delete html when only title remains)
    const htmlExists = await provider.exists(htmlFilePath);
    if (htmlExists) {
      await provider.deleteFile(htmlFilePath);
    }
  }

  return {
    htmlGenerated,
    pdfGenerated,
    htmlFilePath: htmlGenerated ? htmlFilePath : null,
    pdfFilePath: pdfGenerated ? pdfFilePath : null,
  };
}

async function readUriAsBytes(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export { DEFAULT_CSS };
