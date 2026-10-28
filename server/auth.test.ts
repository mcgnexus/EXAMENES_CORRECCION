import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth';

let app: FastifyInstance;

beforeEach(async () => {
  process.env.AUTH_USER = 'profesor';
  process.env.AUTH_PASSWORD = 'clave-secreta';
  app = Fastify();
  registerAuth(app);
  app.get('/api/private', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.AUTH_USER;
  delete process.env.AUTH_PASSWORD;
});

describe('acceso con usuario y contraseña', () => {
  it('expone el estado sin sesión y protege las rutas privadas', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json()).toEqual({ required: true, authenticated: false, user: 'profesor' });

    const denied = await app.inject({ method: 'GET', url: '/api/private' });
    expect(denied.statusCode).toBe(401);
  });

  it('rechaza credenciales incorrectas', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'profesor', password: 'incorrecta' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('crea una cookie HttpOnly y permite acceder con ella', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'profesor', password: 'clave-secreta' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true });
  });

  it('mantiene Basic Auth para scripts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/private',
      headers: {
        authorization: `Basic ${Buffer.from('profesor:clave-secreta').toString('base64')}`,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('invalida la sesión al cerrar sesión', async () => {
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
