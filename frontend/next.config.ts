import type { NextConfig } from "next";

/**
 * The dashboard talks to the Express API through same-origin rewrites. The browser only
 * ever sees one origin, so the session cookie is first-party and there is no CORS to
 * configure. OAuth callbacks (/auth, /integrations) and Bull Board go through the same path.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";
const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy for the dashboard. Email bodies are sanitised before rendering;
 * this limits the damage if anything ever slipped through: no scripts from other origins,
 * no plugins, no framing, and requests only to this origin. Next.js's own bootstrap needs
 * inline scripts ('unsafe-eval' only in dev for fast refresh). Images may come from https
 * (Google avatars, images inside email bodies).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  // Lets the dev server accept requests arriving through an ngrok tunnel.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app", "*.ngrok.app"],
  experimental: {
    // Proxied request bodies are cut at 10 MB by default, which would break an upload of
    // several attachments (5 × 10 MB max, plus multipart overhead). The API enforces the
    // real limits; this only stops anything far beyond them at the edge.
    proxyClientMaxBodySize: "52mb",
  },
  poweredByHeader: false,
  async headers() {
    // Proxied API routes set their own headers (and Bull Board needs its own inline UI).
    return [{ source: "/((?!api/|auth/|integrations/|admin/queues).*)", headers: securityHeaders }];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      { source: "/auth/:path*", destination: `${API_ORIGIN}/auth/:path*` },
      { source: "/integrations/:path*", destination: `${API_ORIGIN}/integrations/:path*` },
      { source: "/admin/queues", destination: `${API_ORIGIN}/admin/queues` },
      { source: "/admin/queues/:path*", destination: `${API_ORIGIN}/admin/queues/:path*` },
    ];
  },
};

export default nextConfig;
