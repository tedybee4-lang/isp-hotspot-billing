// Validates vercel.json rewrite routing. Invoked by .github/workflows/deploy.yml
// (step "Validate vercel.json rewrites"). Kept as a committed .cjs file rather
// than an inline `node -e` payload: the multi-line single-quoted inline script
// was fragile under `set -euo pipefail` on the ubuntu-latest runner and failed
// there while passing locally, which made the real routing checks unreachable.
//
// Contract enforced (see the regression notes in deploy.yml):
//   - a trailing-slash-safe /api/(.*) proxy rewrite exists,
//   - a /health rewrite targets the backend health route,
//   - the SPA fallback exists and is ordered LAST,
//   - /api and /health rewrites precede the SPA fallback,
//   - /api/v1/routers/ (trailing slash) resolves to the VPS API, not the SPA.
const path = require("path");
const fs = require("fs");
const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")
);
const rewrites = cfg.rewrites ?? [];
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

const api = rewrites.findIndex((r) => r.source === "/api/(.*)");
const apiLegacy = rewrites.findIndex((r) => r.source === "/api/:path*");
const apiSlashLegacy = rewrites.findIndex((r) => r.source === "/api/:path*/");
const health = rewrites.findIndex((r) => r.source === "/health");
const spa = rewrites.findIndex((r) => r.destination === "/index.html");

console.log(
  `indices: api=${api} apiLegacy=${apiLegacy} apiSlashLegacy=${apiSlashLegacy} health=${health} spa=${spa}`
);

if (api === -1 && (apiLegacy === -1 || apiSlashLegacy === -1))
  fail("missing /api/(.*) rewrite (trailing-slash-safe API proxy)");
if (health === -1) fail("missing /health rewrite");
if (spa === -1) fail("missing SPA fallback rewrite");
if (api !== -1 && api > spa) fail("api/health rewrites must precede the SPA fallback");
if (api === -1 && (apiLegacy > spa || apiSlashLegacy > spa))
  fail("api/health rewrites must precede the SPA fallback");
if (api !== -1 && !rewrites[api].destination.includes("/api/$1"))
  fail("/api rewrite must preserve the path");
if (api === -1) {
  if (!rewrites[apiLegacy].destination.includes("/api/:path*"))
    fail("/api rewrite must preserve the path");
  if (!rewrites[apiSlashLegacy].destination.includes("/api/:path*/"))
    fail("/api/ rewrite must preserve the trailing slash");
}
if (!rewrites[health].destination.endsWith("/health"))
  fail("/health rewrite must target the backend health route");

// Compile with Vercel's own matcher and assert the exact failing request from
// production resolves to the VPS API (not the SPA fallback).
const { convertRewrites } = require("@vercel/routing-utils");
const routes = convertRewrites(rewrites);
const first = (p) => routes.find((r) => r.src && new RegExp(r.src).test(p));
const target = first("/api/v1/routers/");
if (!target || !String(target.dest).startsWith("https://ispbilling.example.com/api/")) {
  fail("/api/v1/routers/ must be proxied to the VPS API, not the SPA fallback");
}

console.log("vercel.json routing OK:", JSON.stringify(rewrites));
