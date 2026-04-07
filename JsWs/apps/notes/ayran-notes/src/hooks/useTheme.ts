import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../store/settings.store';

export interface Theme {
  isDark: boolean;
  colors: {
    background: string;
    surface: string;
    surfaceVariant: string;
    text: string;
    textSecondary: string;
    border: string;
    primary: string;
    primaryForeground: string;
    danger: string;
    star: string;
    headerBackground: string;
    toolbarBackground: string;
    footerBackground: string;
  };
}

const LIGHT_THEME: Theme['colors'] = {
  background: '#f6f8fa',
  surface: '#ffffff',
  surfaceVariant: '#f1f3f4',
  text: '#24292e',
  textSecondary: '#57606a',
  border: '#d0d7de',
  primary: '#0969da',
  primaryForeground: '#ffffff',
  danger: '#cf222e',
  star: '#d4a017',
  headerBackground: '#24292e',
  toolbarBackground: '#f6f8fa',
  footerBackground: '#24292e',
};

const DARK_THEME: Theme['colors'] = {
  background: '#0d1117',
  surface: '#161b22',
  surfaceVariant: '#1c2128',
  text: '#e1e4e8',
  textSecondary: '#8b949e',
  border: '#30363d',
  primary: '#58a6ff',
  primaryForeground: '#0d1117',
  danger: '#f85149',
  star: '#e3b341',
  headerBackground: '#161b22',
  toolbarBackground: '#0d1117',
  footerBackground: '#161b22',
};

export function useTheme(): Theme {
  const systemScheme = useColorScheme();
  const darkModeSetting = useSettingsStore((s) => s.darkMode);

  let isDark: boolean;
  if (darkModeSetting === 'system') {
    isDark = systemScheme === 'dark';
  } else {
    isDark = darkModeSetting === 'dark';
  }

  return {
    isDark,
    colors: isDark ? DARK_THEME : LIGHT_THEME,
  };
}
