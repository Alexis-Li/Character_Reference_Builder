import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb", // Increased for large media files
    },
  },
  // Note: For route handlers (.../route.ts files), body size is controlled by
  // the underlying server. For large payloads, consider using streaming or
  // increase Node.js max HTTP header size if needed.
  turbopack: {
    root: __dirname,
  },
  /**
   * Baseline response hardening (CRB-09).
   *
   * The application origin must not treat a downloaded or imported response as
   * a script or a document: `nosniff` stops type guessing, and the referrer
   * policy keeps project URLs out of outbound requests. A full CSP is
   * deliberately not set here — Next injects inline bootstrap scripts, so a
   * blanket policy would either break the app or become a permissive rubber
   * stamp; media that could execute (SVG) is handled at the serving route with
   * its own download policy instead.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
