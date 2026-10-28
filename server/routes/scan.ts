import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings } from '../db';
import { badRequest } from '../errors';
import { isTransientProviderError, runProviderScan } from '../llm/providers';
import { renderUploadToImages } from '../storage';
import { collectMultipart } from '../multipart';

const esperadoSchema = z.enum(['auto', 'examen', 'lista']);

export async function registerScanRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/scan', async (request) => {
    const { fields, files } = await collectMultipart(request);
    const esperado = esperadoSchema.safeParse(fields.esperado ?? 'auto');
    const file = files[0];
    if (!file) throw badRequest('Falta la imagen o el PDF a escanear');
    if (!esperado.success) throw badRequest('Tipo de escaneo inválido (auto, examen o lista)');

    let images;
    try {
      images = await renderUploadToImages(file);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Formato de escaneo no soportado');
    }
    if (images.length === 0) throw badRequest('No se ha podido renderizar el documento para el escaneo');

    const settings = await getSettings();
    // Failover: primario → alternativos, solo ante errores transitorios.
    const seen = new Set<string>();
    const chain = [settings.primary, ...settings.independent].filter((config) => {
      const key = `${config.provider}:${config.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    let lastError: unknown = null;
    for (const config of chain) {
      try {
        return await runProviderScan(config.provider, config.model, {
          esperado: esperado.data,
          images,
        });
      } catch (error) {
        lastError = error;
        if (!isTransientProviderError(error)) break;
        console.warn(
          `[llm] escáner con ${config.provider}/${config.model} no disponible (transitorio); probando el siguiente modelo…`,
        );
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw badRequest(`El escaneo ha fallado: ${message}. Reinténtalo en unos segundos.`);
  });
}
