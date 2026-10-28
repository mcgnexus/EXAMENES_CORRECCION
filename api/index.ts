import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServer } from './_server.js';

let appPromise: ReturnType<typeof buildServer> | undefined;

/**
 * Vercel reescribe /api/:path* a /api/index?__path=:path*. Reconstruimos la URL
 * original para que Fastify enrute igual que en local.
 */
function originalUrl(request: IncomingMessage): string {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const rewritten = url.searchParams.get('__path');
  if (rewritten === null) return request.url ?? '/api';

  url.searchParams.delete('__path');
  const query = url.searchParams.toString();
  return `/api/${rewritten.replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  request.url = originalUrl(request);
  appPromise ??= buildServer({ serverless: true });
  const app = await appPromise;
  await app.ready();
  app.server.emit('request', request, response);
}
