import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ayran CsDrive WebHost',
  description: 'Cloud storage web interface',
};

// Runs synchronously before React hydrates — sets .light or .dark on <html>
// so there is never a flash of unstyled content.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');document.documentElement.classList.add(t==='dark'?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script mutates classList before React
    // hydrates, so the server-rendered HTML won't match — this silences that.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
