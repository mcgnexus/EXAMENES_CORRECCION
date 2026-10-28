import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServer } from './_server.js';

let appPromise: ReturnType<typeof buildServer> | undefined;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  appPromise ??= buildServer({ serverless: true });
  const app = await appPromise;
  await app.ready();
  app.server.emit('request', request, response);
}
