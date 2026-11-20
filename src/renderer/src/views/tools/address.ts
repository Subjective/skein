// What the Browser tab's address bar accepts, and how it shows an address. Pure, for tests.
//   5173, :5173, localhost:5173/x, 127.0.0.1:8080   ->  http://localhost:5173/ ... (a dev server)
//   example.com/docs                                  ->  https://example.com/docs
//   http(s)://anything                                ->  as typed
//   other schemes (file:, javascript:, about:) and text that is not an address  ->  null

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;
/** A host name that means "this machine" (for a thread on an SSH machine: that machine). */
export const isLocalHost = (host: string) => LOCAL.test(host);

export function normalize(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^\d{1,5}$/.test(s)) return port(+s) ? `http://localhost:${s}/` : null;
  if (/^:\d{1,5}([/?#].*)?$/.test(s)) return parse('http://localhost' + s);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return /^https?:\/\//i.test(s) ? parse(s) : null;
  // a scheme without // (mailto:, javascript:, about:blank), but not host:port
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null;
  const host = s.replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (isLocalHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return parse('http://' + s);
  // a bare name with a port (devbox:3000) is a dev server too
  if (/^[a-z0-9-]+:\d{1,5}([/?#].*)?$/i.test(s)) return parse('http://' + s);
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return parse('https://' + s);
  return null;
}

const port = (n: number) => n >= 1 && n <= 65535;
function parse(s: string): string | null {
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.port && !port(+u.port)) return null;
    return u.href;
  } catch { return null; }
}

/** How the bar shows an address: no http://, no lone trailing /. https:// stays, so it is never mistaken for http. */
export function display(url: string): string {
  if (!url) return '';
  return url.replace(/^http:\/\//i, '').replace(/^((?:https:\/\/)?[^/?#]+)\/$/, '$1');
}

/** host:port for a tab title. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** The port a URL talks to. */
export function portOf(url: string): number {
  const u = new URL(url);
  return +(u.port || (u.protocol === 'https:' ? 443 : 80));
}

/** Point a URL at another local port, keeping its path (the forwarded one, or back from it). */
export function withPort(url: string, p: number, host = 'localhost'): string {
  const u = new URL(url);
  u.hostname = host; u.port = String(p);
  return u.href;
}
