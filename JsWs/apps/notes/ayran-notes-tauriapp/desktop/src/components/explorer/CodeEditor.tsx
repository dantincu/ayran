import { forwardRef, useMemo } from 'react';
import ReactCodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

function getLanguageExtension(filename: string): Extension {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown'].includes(ext)) return markdown();
  if (['html', 'htm'].includes(ext)) return html();
  if (ext === 'css') return css();
  if (['js', 'jsx'].includes(ext)) return javascript({ jsx: true });
  if (['ts', 'tsx'].includes(ext)) return javascript({ jsx: true, typescript: true });
  if (ext === 'json') return json();
  if (['xml', 'svg', 'rss', 'atom'].includes(ext)) return xml();
  return [];
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  filename: string;
  isDark: boolean;
}

const CodeEditor = forwardRef<ReactCodeMirrorRef, Props>(
  ({ value, onChange, filename, isDark }, ref) => {
    const extensions = useMemo<Extension[]>(
      () => [getLanguageExtension(filename), EditorView.lineWrapping],
      [filename],
    );

    return (
      <ReactCodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={isDark ? oneDark : 'light'}
        height="100%"
        style={{ height: '100%' }}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          foldGutter: false,
          dropCursor: true,
          allowMultipleSelections: false,
          indentOnInput: true,
          syntaxHighlighting: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: false,
          crosshairCursor: false,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          defaultKeymap: true,
          searchKeymap: true,
          historyKeymap: true,
          foldKeymap: false,
          completionKeymap: false,
          lintKeymap: false,
        }}
      />
    );
  },
);

export default CodeEditor;
