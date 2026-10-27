import type { FastifyInstance } from 'fastify';
import { eventBus } from '../events';

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    reply.raw.write(': conectado\n\n');

    const listener = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    eventBus.on('event', listener);

    const keepAlive = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      eventBus.off('event', listener);
      reply.raw.end();
    });
  });
}
