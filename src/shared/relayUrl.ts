// Shared relay-URL normalization for GameSocket and ControllerSocket. Both
// sides read the same VITE_RELAY_URL env var (a build-time constant baked in
// separately per app when the controller/game pages are hosted apart from
// the relay, e.g. a static host + a Railway relay) and used to each hand-roll
// their own resolveRelayUrl() with slightly different (and both fairly
// fragile) assumptions about its shape. This accepts every shape a human
// would reasonably type into an env var:
//   wss://host        -> wss://host/ws
//   wss://host/ws     -> wss://host/ws (unchanged)
//   https://host      -> wss://host/ws       (http(s) mapped to ws(s))
//   http://host       -> ws://host/ws
//   host[:port]       -> ws(s)://host[:port]/ws (scheme borrowed from `fallback`)
// and never throws — an unset or unparseable value falls back to same-origin
// `/ws`, using `fallback` (normally the page's own location) for the scheme.
export interface RelayUrlFallback {
  protocol: string; // e.g. location.protocol: 'http:' | 'https:'
  host: string; // e.g. location.host: 'example.com' or 'example.com:8787'
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function sameOriginWs(fallback: RelayUrlFallback): string {
  const proto = fallback.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${fallback.host}/ws`;
}

export function resolveRelayUrl(configured: string | null | undefined, fallback: RelayUrlFallback): string {
  const trimmed = configured?.trim();
  if (!trimmed) return sameOriginWs(fallback);

  // Host-only (no scheme): borrow the ws/wss family from `fallback`'s protocol.
  const withScheme = SCHEME_RE.test(trimmed)
    ? trimmed
    : `${fallback.protocol === 'https:' ? 'wss' : 'ws'}://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return sameOriginWs(fallback);

    if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  } catch {
    return sameOriginWs(fallback);
  }
}
