import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { ROOT, recoverInterruptedWork } from './db';
import { HttpError } from './errors';
import { registerClassRoutes } from './routes/classes';
import { registerActivityRoutes } from './routes/activities';
import { registerSubmissionRoutes } from './routes/submissions';
import { registerJobRoutes } from './routes/jobs';
import { registerSettingsRoutes } from './routes/settings';
import { registerFileRoutes } from './routes/files';
import { registerExportRoutes } from './routes/export';
import { registerEventRoutes } from './routes/events';

export async function buildServer(): Promise<FastifyInstance> {
  recoverInterruptedWork();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'warn',
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 60 * 1024 * 1024,
      files: 20,
      fields: 20,
    },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  await registerClassRoutes(app);
  await registerActivityRoutes(app);
  await registerSubmissionRoutes(app);
  await registerJobRoutes(app);
  await registerSettingsRoutes(app);
  await registerFileRoutes(app);
  await registerExportRoutes(app);
  await registerEventRoutes(app);

  app.get('/api/health', async () => ({ ok: true }));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'Datos inválidos',
        details: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      return;
    }
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) app.log.error(error as Error);
    reply.code(statusCode).send({ error: (error as Error).message || 'Error interno' });
  });

  const clientDir = path.join(ROOT, 'dist', 'client');
  const hasClient = fs.existsSync(path.join(clientDir, 'index.html'));

  if (hasClient) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      wildcard: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      reply.code(404).send({ error: 'Ruta no encontrada' });
      return;
    }
    if (hasClient) {
      return reply.sendFile('index.html');
    }
    return reply
      .code(200)
      .type('text/html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Exámenes</title>' +
          '<p>Servidor API en marcha. Ejecuta <code>npm run dev</code> para abrir la interfaz ' +
          '(Vite en http://localhost:5173) o <code>npm run build</code> para servirla desde aquí.</p>',
      );
  });

  return app;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = await buildServer();
  try {
    await app.listen({ port, host });
    console.log(`API de corrección escuchando en http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
