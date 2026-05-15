import { useState, useEffect } from 'react';

type Theme = 'light' | 'dark';

function applyTheme(theme: Theme) {
  const cl = document.documentElement.classList;
  cl.remove('light', 'dark');
  cl.add(theme);
  localStorage.setItem('theme', theme);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const t: Theme = stored === 'dark' ? 'dark' : 'light';
    setTheme(t);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
  };

  return { theme, toggleTheme };
}
