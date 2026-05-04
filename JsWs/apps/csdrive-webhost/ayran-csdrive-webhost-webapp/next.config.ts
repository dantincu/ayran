import type { NextConfig } from 'next';

const csp = [
  "default-src 'self'",
  // Next.js needs unsafe-inline for its hydration script tag; unsafe-eval for dev HMR source maps
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // THE key directive: browser JS may only fetch/XHR back to this origin
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  serverExternalPackages: ['googleapis', 'google-auth-library'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [{ key: 'Content-Security-Policy', value: csp }],
      },
    ];
  },
};

export default nextConfig;
