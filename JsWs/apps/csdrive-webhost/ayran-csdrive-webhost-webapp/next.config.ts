import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['googleapis', 'google-auth-library'],
};

export default nextConfig;
