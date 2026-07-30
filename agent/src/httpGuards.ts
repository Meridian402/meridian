import type { Request, Response, NextFunction } from "express";

// Security headers, set by hand rather than pulling in `helmet`. This is a JSON
// API (no HTML), so CSP is moot, and helmet's default Cross-Origin-Resource-
// Policy would break our intentionally open-CORS public read endpoints. These
// are the headers that actually matter for an API surface.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
}

// Per-IP token bucket. A single limiter map per instance; `trust proxy` must be
// set so req.ip is the real client, not Railway's edge. The global limiter is
// generous on purpose (it must never throttle the live desk's legit polling —
// one active viewer runs ~300 req/min — only stop an actual flood); the auth
// limiter is strict because sign-in and signature verification are expensive and
// never happen dozens of times a minute for a real user.
type Bucket = { tokens: number; last: number };

function makeLimiter(maxPerMin: number) {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = maxPerMin / 60_000;
  let lastSweep = Date.now();
  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const b = buckets.get(ip) ?? { tokens: maxPerMin, last: now };
    b.tokens = Math.min(maxPerMin, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    if (b.tokens < 1) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ error: "rate limit exceeded — slow down" });
      return;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    if (now - lastSweep > 5 * 60_000) {
      lastSweep = now;
      for (const [k, v] of buckets) if (now - v.last > 10 * 60_000) buckets.delete(k);
    }
    next();
  };
}

// Global flood guard (skips /health so Railway's probe is never throttled).
const _globalLimiter = makeLimiter(Number(process.env.GLOBAL_RATE_PER_MIN ?? 1800));
export function globalRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") return next();
  return _globalLimiter(req, res, next);
}

// Strict guard for the unauthenticated, CPU-heavy auth endpoints.
export const authRateLimit = makeLimiter(Number(process.env.AUTH_RATE_PER_MIN ?? 30));

// The route prefixes this server actually serves, as the first one or two path
// segments. Request accounting is keyed off this list rather than off whatever
// the caller typed: the counter map used to take its key straight from the
// request path, which meant anyone could grow it without limit just by asking
// for random URLs, and the 404s they were generating were also the least
// interesting rows in the table.
const KNOWN_ROUTES = new Set([
  "/health",
  "/mcp",
  "/api/account",
  "/api/admin",
  "/api/agent-thoughts",
  "/api/console",
  "/api/credits",
  "/api/custody",
  "/api/earn",
  "/api/fleet",
  "/api/index-trade",
  "/api/lp-close",
  "/api/lp-open",
  "/api/lp-pnl",
  "/api/lp-scan",
  "/api/market-data",
  "/api/my-agent",
  "/api/open-deploy",
  "/api/opportunities",
  "/api/ops",
  "/api/performance",
  "/api/portfolio",
  "/api/proof",
  "/api/research-universe",
  "/api/reserve-profile",
  "/api/swarm",
  "/api/sync-state",
]);

export const OTHER_ROUTE_KEY = "other";

/**
 * The accounting key for a request path: a known prefix, or "other". Bounded by
 * construction, so the stats map can hold at most KNOWN_ROUTES.size + 1 entries
 * no matter what anyone requests.
 */
export function routeKey(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return OTHER_ROUTE_KEY;
  const two = "/" + segments.slice(0, 2).join("/");
  if (KNOWN_ROUTES.has(two)) return two;
  const one = "/" + segments[0];
  return KNOWN_ROUTES.has(one) ? one : OTHER_ROUTE_KEY;
}

/** How many distinct keys routeKey can ever produce. Used by the test that
 *  proves the stats map is bounded. */
export const ROUTE_KEY_LIMIT = KNOWN_ROUTES.size + 1;
