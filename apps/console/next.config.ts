import type { NextConfig } from "next";
import path from "node:path";

const apiOrigin = (process.env.SAFENET_API_URL || "http://127.0.0.1:8100").replace(/\/$/, "");

const config: NextConfig = {
  distDir: process.env.SAFENET_BUILD_DIR || ".next",
  output: "standalone",
  poweredByHeader: false,
  // Leave room for the multipart envelope around a 64 MiB file.
  experimental: { proxyClientMaxBodySize: "65mb", proxyTimeout: 180000 },
  turbopack: { root: path.resolve(process.cwd()) },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
};
export default config;
