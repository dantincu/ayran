import React, { useRef, useCallback, useEffect } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useTheme } from '../../hooks/useTheme';

const EDITOR_HTML = require('../../../assets/monaco/index.html');

interface MonacoEditorProps {
  content: string;
  onChange: (content: string) => void;
  onReady?: () => void;
}

export function MonacoEditor({ content, onChange, onReady }: MonacoEditorProps) {
  const theme = useTheme();
  const webViewRef = useRef<WebView>(null);
  const isReady = useRef(false);
  const pendingContent = useRef<string | null>(null);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(JSON.stringify(msg))} })); true;`,
    );
  }, []);

  const setContent = useCallback((text: string) => {
    if (!isReady.current) {
      pendingContent.current = text;
      return;
    }
    sendMessage({ type: 'setContent', content: text });
  }, [sendMessage]);

  useEffect(() => {
    setContent(content);
  }, [content, setContent]);

  useEffect(() => {
    if (isReady.current) {
      sendMessage({ type: 'setTheme', theme: theme.isDark ? 'dark' : 'light' });
    }
  }, [theme.isDark, sendMessage]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type: string; content?: string };
      if (msg.type === 'ready') {
        isReady.current = true;
        sendMessage({ type: 'setTheme', theme: theme.isDark ? 'dark' : 'light' });
        if (pendingContent.current !== null) {
          sendMessage({ type: 'setContent', content: pendingContent.current });
          pendingContent.current = null;
        } else {
          sendMessage({ type: 'setContent', content: content });
        }
        onReady?.();
      } else if (msg.type === 'contentChange' && msg.content !== undefined) {
        onChange(msg.content);
      }
    } catch {
      // ignore
    }
  }, [content, onChange, onReady, sendMessage, theme.isDark]);

  return (
    <View style={[styles.container, { backgroundColor: theme.isDark ? '#1e1e1e' : '#ffffff' }]}>
      <WebView
        ref={webViewRef}
        source={EDITOR_HTML}
        style={styles.webview}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        scrollEnabled={false}
        originWhitelist={['*']}
        allowFileAccess={true}
        mixedContentMode="always"
        keyboardDisplayRequiresUserAction={false}
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
    opacity: 0.99, // Android WebView rendering fix
  },
});
