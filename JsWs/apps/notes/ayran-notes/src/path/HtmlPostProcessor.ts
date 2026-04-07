import { IStorageProvider } from '../types/storage.types';
import { parseAyranPath, resolveAyranPath, isAyranPath } from './AyranPath';
import { AyranPathType } from '../types/path.types';

export interface PostProcessContext {
  provider: IStorageProvider;
  notebookRootPath: string;
  currentNotePath: string;
  currentDirPath: string;
  darkMode: boolean;
  customCss?: string | null;
}

/**
 * Process raw HTML through the Ayran post-processing pipeline:
 * 1. Remove <script> elements
 * 2. Remove <object>, external <link rel="stylesheet">, <base> tags
 * 3. Inline CSS @import statements inside <style> tags
 * 4. Rewrite <a href> with Ayran paths to ayran:// scheme
 * 5. Rewrite <img src> with Ayran paths to data: URIs
 * 6. Apply dark/light theme class on <html>
 * 7. Strip content outside <body>
 * 8. Inject stylesheet
 */
export async function postProcessHtml(
  html: string,
  context: PostProcessContext,
): Promise<string> {
  let result = html;

  // 1. Remove <script> tags
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<script\b[^>]*\/>/gi, '');

  // 2. Remove <object>, <base>, external <link rel="stylesheet">
  result = result.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
  result = result.replace(/<base\b[^>]*\/?>/gi, '');
  result = result.replace(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\/?\s*>/gi, '');

  // 3. Process <style> tags: inline @import
  result = await processStyleImports(result, context);

  // 4. Rewrite <a href>
  result = rewriteLinks(result, context);

  // 5. Rewrite <img src> — async for data URI conversion
  result = await rewriteImages(result, context);

  // 6. Apply theme class
  result = applyThemeClass(result, context.darkMode);

  // 7. Extract body content from full HTML documents
  result = extractBodyContent(result);

  return result;
}

function extractBodyContent(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const styleMatches = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];

  if (bodyMatch) {
    const body = bodyMatch[1];
    const styles = styleMatches.map((m) => `<style>${m[1]}</style>`).join('\n');
    return styles + body;
  }
  return html;
}

function applyThemeClass(html: string, darkMode: boolean): string {
  const themeClass = darkMode ? 'dark' : 'light';
  // Check if <html> tag already has .dark or .light
  if (/<html[^>]*class="[^"]*(?:dark|light)[^"]*"/i.test(html)) {
    return html;
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (match, attrs) => {
      if (/class=/i.test(attrs)) {
        return `<html${attrs.replace(/class="([^"]*)"/i, `class="$1 ${themeClass}"`)}>`;
      }
      return `<html${attrs} class="${themeClass}">`;
    });
  }
  // No <html> tag — wrap in div
  return `<div class="${themeClass}">${html}</div>`;
}

function rewriteLinks(html: string, context: PostProcessContext): string {
  return html.replace(/<a\s([^>]*href=["'])([^"']+)(["'][^>]*)>/gi, (match, pre, href, post) => {
    if (!isAyranPath(href) && !/^\.{0,2}\//.test(href)) return match;
    const parsed = parseAyranPath(href);
    if (parsed.type === AyranPathType.External) return match;
    const resolved = resolveAyranPath(
      parsed,
      context.notebookRootPath,
      context.currentNotePath,
      context.currentDirPath,
    );
    // Use ayran:// scheme so the WebView can intercept it
    const ayranUri = `ayran://navigate?path=${encodeURIComponent(resolved.storagePath)}&isNote=${resolved.isNote}`;
    return `<a ${pre}${ayranUri}${post}>`;
  });
}

async function rewriteImages(html: string, context: PostProcessContext): Promise<string> {
  const imgPattern = /<img\s([^>]*src=["'])([^"']+)(["'][^>]*\/?\s*)>/gi;
  const matches = [...html.matchAll(imgPattern)];

  for (const match of matches) {
    const [fullMatch, pre, src, post] = match;
    if (!isAyranPath(src) && !/^\.{0,2}\//.test(src)) continue;

    try {
      const parsed = parseAyranPath(src);
      if (parsed.type === AyranPathType.External) continue;
      const resolved = resolveAyranPath(
        parsed,
        context.notebookRootPath,
        context.currentNotePath,
        context.currentDirPath,
      );
      const bytes = await context.provider.readFileBytes(resolved.storagePath);
      const b64 = bytesToBase64(bytes);
      const mimeType = getMimeType(resolved.storagePath);
      const dataUri = `data:${mimeType};base64,${b64}`;
      html = html.replace(fullMatch, `<img ${pre}${dataUri}${post}>`);
    } catch {
      // If image can't be loaded, leave as-is
    }
  }

  return html;
}

async function processStyleImports(html: string, context: PostProcessContext): Promise<string> {
  const stylePattern = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  const result: string[] = [];
  let lastIndex = 0;

  for (const match of html.matchAll(stylePattern)) {
    result.push(html.slice(lastIndex, match.index));
    const [fullMatch, open, cssContent, close] = match;
    const processedCss = await processImports(cssContent, context);
    result.push(`${open}${processedCss}${close}`);
    lastIndex = (match.index ?? 0) + fullMatch.length;
  }
  result.push(html.slice(lastIndex));
  return result.join('');
}

async function processImports(css: string, context: PostProcessContext): Promise<string> {
  // Match @import url("...") or @import "..." with possible | characters in the URL
  const importPattern = /@import\s+(?:url\(["']?([^"')]+)["']?\)|["']([^"']+)["'])\s*;?/g;
  const matches = [...css.matchAll(importPattern)];

  let result = css;
  for (const match of matches) {
    const importPath = match[1] ?? match[2];
    if (!importPath) continue;
    try {
      const parsed = parseAyranPath(importPath);
      const resolved = resolveAyranPath(
        parsed,
        context.notebookRootPath,
        context.currentNotePath,
        context.currentDirPath,
      );
      const importedCss = await context.provider.readFile(resolved.storagePath);
      result = result.replace(match[0], importedCss);
    } catch {
      result = result.replace(match[0], `/* @import failed: ${importPath} */`);
    }
  }
  return result;
}

function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return types[ext] ?? 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
