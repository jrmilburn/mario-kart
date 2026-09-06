interface PublicControllerUrlOptions {
  publicUrl?: string;
  railwayPublicDomain?: string;
  requestOrigin?: string;
}

function httpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

// The server's network interface is a private container address on hosted
// platforms. Prefer configured public domains, then the HTTPS game's origin.
// Return null for local development so index.ts can retain LAN/mkcert discovery.
export function publicControllerUrl(code: string, options: PublicControllerUrlOptions): string | null {
  const explicit = httpUrl(options.publicUrl);
  const railway = options.railwayPublicDomain ? httpUrl(`https://${options.railwayPublicDomain}`) : null;
  const origin = httpUrl(options.requestOrigin);
  const loopback = origin && (
    origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost') ||
    origin.hostname.startsWith('127.') || origin.hostname === '[::1]'
  );
  const base = explicit ?? railway ?? (origin?.protocol === 'https:' && !loopback ? origin : null);
  if (!base) return null;
  const url = new URL('/controller.html', base);
  url.searchParams.set('room', code);
  return url.href;
}
