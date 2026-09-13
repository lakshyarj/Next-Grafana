/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,

  // The Grafana proxy buffers and re-emits responses itself, so we keep
  // Next's own body handling out of the way for that route.
  experimental: {
    proxyTimeout: 30_000,
  },

  async headers() {
    return [
      {
        // Defence in depth: this app should only ever be framed by itself.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
