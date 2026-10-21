// Security headers for every response the Worker sends: the board's HTML and assets (served through
// the Worker, run_worker_first in wrangler.jsonc) and both /api endpoints.
//
// The CSP fits this page only:
// - scripts: the built bundle from this origin, nothing inline (Vite emits no inline script);
// - styles: this origin plus inline, because the board renders its stylesheet in a <style> element
//   (components/wdc/wdc-styles.ts) and index.html sets the page ground inline; plus the Bunny Fonts
//   stylesheet (Saira + Barlow), the only third-party request the page makes;
// - fonts: this origin and fonts.bunny.net;
// - connect: this origin only (GET /api/board, POST /api/save). BCP is called by the Worker, never
//   by the browser; the BCP army-list links are plain anchors, which CSP does not govern;
// - no framing, no plugins, no <base> or form posts elsewhere.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.bunny.net",
  "font-src 'self' data: https://fonts.bunny.net",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // The board is private by obscurity: unlinked, and kept out of search with this header on every
  // response plus the robots meta tag in index.html.
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
  // The board keeps the screen awake (Screen Wake Lock), so that one stays allowed.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** A copy of `res` with the security headers set (replacing any the asset layer sent). */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}
