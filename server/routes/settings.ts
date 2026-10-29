import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings, saveSettings } from '../db';
import { badRequest } from '../errors';
import { PROVIDER_LIST, getProvider, testProvider } from '../llm/providers';
import type { AppSettings, ProviderInfo } from '../../shared/types';

const providerConfig = z.object({
  provider: z.string().min(1),
  model: z.string().trim().min(1).max(200),
});

const settingsSchema = z.object({
  primary: providerConfig,
  independent: z.array(providerConfig).max(1),
  divergenceThreshold: z.number().min(0.1).max(20),
  concurrency: z.number().int().min(1).max(6),
  includeImages: z.boolean(),
  maxPagesPerEvaluation: z.number().int().min(1).max(20),
});

function providerInfos(): ProviderInfo[] {
  return PROVIDER_LIST.map((provider) => ({
    id: provider.id,
    name: provider.name,
    requiresKey: provider.requiresKey,
    keyVariable: provider.keyVariable,
    defaultModel: provider.defaultModel,
    available:
      !provider.requiresKey ||
      Boolean(provider.keyVariable && process.env[provider.keyVariable]),
  }));
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({
    settings: await getSettings(),
    providers: providerInfos(),
    maxBatch: 10,
  }));

  app.get('/api/settings/providers', async () => ({ providers: providerInfos() }));

  app.put('/api/settings', async (request) => {
    const body = settingsSchema.parse(request.body ?? {}) as AppSettings;
    for (const config of [body.primary, ...body.independent]) {
      if (!getProvider(config.provider)) {
        throw badRequest(`Proveedor desconocido: ${config.provider}`);
      }
    }
    const saved = await saveSettings(body);
    return { settings: saved, providers: providerInfos() };
  });

  app.post('/api/settings/test', async (request) => {
    const body = providerConfig.parse(request.body ?? {});
    if (!getProvider(body.provider)) throw badRequest('Proveedor desconocido');
    try {
      const message = await testProvider(body.provider, body.model);
      return { ok: true, message };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
