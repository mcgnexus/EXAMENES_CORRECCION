import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Rutas que no requieren sesión: salud y el propio flujo de acceso. */
const EXEMPT_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
]);

const COOKIE_NAME = 'examenes_session';
const SESSION_DAYS = 7;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Comparación de longitud también en tiempo constante para no filtrar por timing.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function authConfig(): { enabled: boolean; user: string; password: string } {
  const password = process.env.AUTH_PASSWORD ?? '';
  return {
    enabled: password.length > 0,
    user: process.env.AUTH_USER || 'profesor',
    password,
  };
}

/** Secreto de firma: variable propia o derivado de la contraseña configurada. */
function sessionSecret(password: string): string {
  const explicit = process.env.AUTH_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  return createHmac('sha256', 'examenes-correccion').update(password).digest('hex');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(user: string, password: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload, sessionSecret(password))}`;
}

function verifySessionToken(token: string, user: string, password: string): boolean {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!constantTimeEquals(signature, sign(payload, sessionSecret(password)))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: string;
      exp?: number;
    };
    if (parsed.u !== user) return false;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function isHttps(request: FastifyRequest): boolean {
  if (process.env.VERCEL) return true;
  const proto = request.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https';
}

function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  maxAgeSeconds: number,
): void {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(request)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(request)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

function hasValidBasicAuth(
  header: string | undefined,
  user: string,
  password: string,
): boolean {
  if (!header?.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  const givenUser = separator >= 0 ? decoded.slice(0, separator) : '';
  const givenPassword = separator >= 0 ? decoded.slice(separator + 1) : '';
  return constantTimeEquals(givenUser, user) && constantTimeEquals(givenPassword, password);
}

function isAuthenticated(request: FastifyRequest): boolean {
  const config = authConfig();
  if (!config.enabled) return true;
  if (hasValidBasicAuth(request.headers.authorization, config.user, config.password)) return true;
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  return Boolean(token && verifySessionToken(token, config.user, config.password));
}

/**
 * Acceso con usuario y contraseña. El navegador usa una cookie de sesión
 * firmada (HttpOnly); los scripts pueden seguir usando Basic Auth.
 */
export function registerAuth(app: FastifyInstance): void {
  app.get('/api/auth/status', async (request) => {
    const config = authConfig();
    return {
      required: config.enabled,
      authenticated: isAuthenticated(request),
      user: config.enabled ? config.user : null,
    };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const config = authConfig();
    if (!config.enabled) {
      return { ok: true, required: false };
    }
    const body = z
      .object({
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(500),
      })
      .parse(request.body ?? {});

    const userOk = constantTimeEquals(body.username, config.user);
    const passwordOk = constantTimeEquals(body.password, config.password);
    if (!userOk || !passwordOk) {
      reply.code(401);
      return { error: 'Usuario o contraseña incorrectos' };
    }

    setSessionCookie(request, reply, createSessionToken(config.user, config.password), SESSION_DAYS * 86400);
    return { ok: true, user: config.user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    clearSessionCookie(request, reply);
    reply.code(204);
    return null;
  });

  app.addHook('onRequest', async (request, reply) => {
    const config = authConfig();
    if (!config.enabled) return;

    const path = (request.raw.url ?? '/').split('?')[0];
    if (EXEMPT_PATHS.has(path)) return;
    if (isAuthenticated(request)) return;

    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Exámenes", charset="UTF-8"')
      .send({ error: 'Autenticación requerida' });
  });
}
