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
  // The "Running TypeScript" phase of `next build` wants roughly a gigabyte of heap on
  // top of the compile, which is more than a small VPS has to give — the Docker build
  // aborted there three times with "Reached heap limit". Only the image build sets this
  // flag (docker/Dockerfile), and CI runs `npx tsc --noEmit` on every push, so nothing
  // ships unchecked. A local `npm run build` still type-checks, which matters: tsc
  // alone never looks inside dot-directories like app/.well-known/.
  typescript: {
    ignoreBuildErrors: process.env.NEXT_SKIP_TYPECHECK === "1",
  },
  experimental: {
    // Keep page-data collection stable on small VPS/CI machines. Next otherwise
    // fans out to every logical CPU and can exhaust native memory.
    cpus: 4,
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
