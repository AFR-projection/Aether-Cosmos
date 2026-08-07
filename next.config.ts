import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  compress: true,
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  // nodemailer is Node-only (net/tls) — keep it external so SMTP works in the
  // standalone Docker server, not just `next dev`.
  serverExternalPackages: ["sharp", "@node-rs/argon2", "nodemailer"],
  experimental: {
    turbopackFileSystemCacheForDev: true,
    // lucide-react, date-fns and recharts are already on Next's built-in
    // optimize list — only the barrels it does not cover are listed here.
    optimizePackageImports: ["framer-motion", "@tanstack/react-query"],
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Content-Security-Policy",
          value:
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-eval' 'unsafe-inline' unpkg.com; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://*.r2.dev; " +
            "media-src 'self' blob: https://*.r2.cloudflarestorage.com https://*.r2.dev; " +
            "connect-src 'self' https://*.r2.cloudflarestorage.com https://*.r2.dev;",
        },
      ],
    },
    {
      source: "/favicon.ico",
      headers: [
        { key: "Cache-Control", value: "public, max-age=86400" },
      ],
    },
  ],
};

export default nextConfig;
