export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const serviceUnavailable = (message: string) =>
  new AppError(503, 'service_unavailable', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const tooManyRequests = (message = 'Too many requests. Slow down and try again shortly.') =>
  new AppError(429, 'rate_limited', message);
export const badGateway = (message: string) => new AppError(502, 'upstream_error', message);

/**
 * What is safe to log from a third-party client error. HTTP client errors (Google's gaxios,
 * Slack's axios, Elasticsearch) carry the request they made, including OAuth client secrets,
 * bot tokens and credentialed URLs; logging the raw object would write those to the logs.
 */
export function safeError(err: unknown): { name?: string; message: string; code?: unknown; status?: unknown } {
  if (!(err instanceof Error)) return { message: redactSecrets(String(err)) };
  const e = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown; data?: { error?: unknown } };
  return {
    name: e.name,
    message: redactSecrets(e.message),
    code: e.code ?? e.data?.error,
    status: e.status ?? e.statusCode,
  };
}

/** Masks credentials that can appear inside error text: URL userinfo and token-like strings. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@')
    .replace(/xox[abposr]-[A-Za-z0-9-]+/g, 'xox*-***')
    .replace(/(client_secret|password|pass|token)=([^&\s]+)/gi, '$1=***');
}
