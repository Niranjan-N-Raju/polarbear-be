import type { Express, RequestHandler } from 'express';

const DEV_ORIGINS = [3000, 3001, 3002, 3003, 3004, 3005, 5173].flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Production requires an explicit WEB_ORIGINS allowlist; localhost defaults apply only outside production. */
export function allowedOrigins(): string[] {
  const configured = process.env.WEB_ORIGINS;
  if (configured === undefined) return isProduction() ? [] : DEV_ORIGINS;
  return configured
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== '*');
}

/**
 * TRUST_PROXY must be the exact number of trusted reverse-proxy hops (e.g. "1").
 * `true`/wildcards are rejected because they let clients spoof X-Forwarded-For and bypass per-IP rate limits.
 */
export function configureTrustProxy(app: Express): void {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === '0' || raw === 'false') {
    app.set('trust proxy', false);
    return;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error('TRUST_PROXY must be an integer hop count between 1 and 10.');
  }
  app.set('trust proxy', hops);
}

export const securityHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
  if (isProduction()) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
};

export const cors: RequestHandler = (request, response, next) => {
  const origin = request.header('origin');
  if (origin && allowedOrigins().includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Max-Age', '600');
  }
  response.append('Vary', 'Origin');

  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
};
