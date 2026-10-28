import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings } from '../db';
import { badRequest } from '../errors';
import { runProviderScan, runWithModelFailover } from '../llm/providers';
import { renderUploadToImages } from '../storage';
import type { ImagePart } from '../llm/types';
import { collectMultipart } from '../multipart';

const esperadoSchema = z.enum(['auto', 'examen', 'lista']);

export async function registerScanRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/scan', async (request) => {
    const { fields, files } = await collectMultipart(request);
    const esperado = esperadoSchema.safeParse(fields.esperado ?? 'auto');
    if (files.length === 0) throw badRequest('Falta la imagen o el PDF a escanear');
    if (!esperado.success) throw badRequest('Tipo de escaneo inválido (auto, examen o lista)');

    const images: ImagePart[] = [];
    try {
      for (const file of files.slice(0, 12)) {
        images.push(...(await renderUploadToImages(file)));
      }
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Formato de escaneo no soportado');
    }
    if (images.length === 0) throw badRequest('No se ha podido renderizar el documento para el escaneo');

    const settings = await getSettings();
    // Failover: primario → alternativos, solo ante errores transitorios.
    try {
      return await runWithModelFailover(
        settings.primary,
        settings.independent,
        (provider, model) => runProviderScan(provider, model, { esperado: esperado.data, images }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`El escaneo ha fallado: ${message}. Reinténtalo en unos segundos.`);
    }
  });
}
