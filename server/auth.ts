import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** /api/health no requiere credenciales: lo usan los healthchecks de la plataforma. */
const EXEMPT_PATHS = new Set(['/api/health']);

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

/**
 * Basic Auth global activo solo si AUTH_PASSWORD está definido (despliegues
 * públicos). Sin la variable, la app se comporta como hasta ahora (local).
 */
export function registerAuth(app: FastifyInstance): void {
  const password = process.env.AUTH_PASSWORD;
  if (!password) return;
  const user = process.env.AUTH_USER || 'profesor';

  app.addHook('onRequest', async (request, reply) => {
    const path = (request.raw.url ?? '/').split('?')[0];
    if (EXEMPT_PATHS.has(path)) return;

    const header = request.headers.authorization;
    if (header?.startsWith('Basic ')) {
      let decoded = '';
      try {
        decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      } catch {
        decoded = '';
      }
      const separator = decoded.indexOf(':');
      const givenUser = separator >= 0 ? decoded.slice(0, separator) : '';
      const givenPassword = separator >= 0 ? decoded.slice(separator + 1) : '';
      if (constantTimeEquals(givenUser, user) && constantTimeEquals(givenPassword, password)) {
        return;
      }
    }

    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Exámenes", charset="UTF-8"')
      .send({ error: 'Autenticación requerida' });
  });
}
