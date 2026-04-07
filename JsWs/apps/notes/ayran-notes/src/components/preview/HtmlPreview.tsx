import React, { useRef, useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import { useSessionStore } from '../../store/session.store';
import { getStorageProvider } from '../../storage/StorageProviderFactory';
import { markdownToHtml } from '../../notebook/NoteExporter';
import { postProcessHtml, PostProcessContext } from '../../path/HtmlPostProcessor';
import { parseAyranSchemeUri } from '../../path/LinkResolver';

interface HtmlPreviewProps {
  markdownContent?: string;
  rawHtml?: string;
  notePath: string;
  notebookRootPath: string;
  darkMode: boolean;
  customCss?: string | null;
  onHoverLink?: (link: string | null) => void;
  onNavigate?: (storagePath: string, isNote: boolean) => void;
}

// Injected JS to intercept link hovers/clicks without running user JS
const INTERCEPT_SCRIPT = `
(function() {
  document.addEventListener('mouseover', function(e) {
    var el = e.target.closest('a');
    if (el && el.href) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'hover', href: el.href }));
    }
  });
  document.addEventListener('mouseout', function(e) {
    var el = e.target.closest('a');
    if (el) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'hoverOut' }));
    }
  });
  // Prevent all form submissions
  document.addEventListener('submit', function(e) { e.preventDefault(); });
  true;
})();
`;

export function HtmlPreview({
  markdownContent,
  rawHtml,
  notePath,
  notebookRootPath,
  darkMode,
  customCss,
  onHoverLink,
  onNavigate,
}: HtmlPreviewProps) {
  const webViewRef = useRef<WebView>(null);
  const [processedHtml, setProcessedHtml] = useState<string>('');
  const session = useSessionStore((s) => s.getCurrentSession());

  const generateHtml = useCallback(async () => {
    const provider = session ? getStorageProvider(session.storageProviderId) : undefined;

    let html: string;
    if (markdownContent !== undefined) {
      html = await markdownToHtml(markdownContent, darkMode, customCss);
    } else {
      html = rawHtml ?? '';
    }

    if (provider) {
      const context: PostProcessContext = {
        provider,
        notebookRootPath,
        currentNotePath: notePath,
        currentDirPath: notebookRootPath,
        darkMode,
        customCss,
      };
      html = await postProcessHtml(html, context);
    }

    setProcessedHtml(html);
  }, [markdownContent, rawHtml, notePath, notebookRootPath, darkMode, customCss, session]);

  useEffect(() => {
    generateHtml();
  }, [generateHtml]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type: string; href?: string };
      if (msg.type === 'hover') {
        onHoverLink?.(msg.href ?? null);
      } else if (msg.type === 'hoverOut') {
        onHoverLink?.(null);
      }
    } catch {
      // ignore
    }
  }, [onHoverLink]);

  const handleNavigation = useCallback((request: WebViewNavigation): boolean => {
    const url = request.url;

    // Allow initial blank/data load
    if (url === 'about:blank' || url.startsWith('data:')) return true;

    // Handle ayran:// scheme
    if (url.startsWith('ayran://')) {
      const resolved = parseAyranSchemeUri(url);
      if (resolved) {
        onNavigate?.(resolved.storagePath, resolved.isNote);
      }
      return false;
    }

    // Block all other navigation
    onHoverLink?.(url);
    return false;
  }, [onNavigate, onHoverLink]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: processedHtml }}
        style={styles.webview}
        javaScriptEnabled={true}
        injectedJavaScriptBeforeContentLoaded={INTERCEPT_SCRIPT}
        onShouldStartLoadWithRequest={handleNavigation}
        onMessage={handleMessage}
        originWhitelist={['*', 'ayran://*']}
        allowFileAccess={false}
        scrollEnabled={true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});
