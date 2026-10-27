import {
  buildSystemPrompt,
  buildUserPrompt,
  extractJsonObject,
  normalizeModelOutput,
} from './prompts';
import type {
  GradingInput,
  GradingOutput,
  ProviderCallContext,
  ProviderDefinition,
  ProviderId,
} from './types';

const TIMEOUT_MS = 180_000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const snippet = text.slice(0, 400);
  return `HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`;
}

async function parseGradingResponse(text: string, input: GradingInput): Promise<GradingOutput> {
  return normalizeModelOutput(extractJsonObject(text), input);
}

// ---------------------------------------------------------------- OpenAI

const openaiProvider: ProviderDefinition = {
  id: 'openai',
  name: 'OpenAI',
  requiresKey: true,
  keyVariable: 'OPENAI_API_KEY',
  defaultModel: 'gpt-4.1',
  async evaluate(input, ctx) {
    const content: unknown[] = [{ type: 'text', text: buildUserPrompt(input) }];
    for (const image of input.images) {
      content.push({ type: 'text', text: `— ${image.label} —` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mime};base64,${image.base64}` },
      });
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ctx.model || openaiProvider.defaultModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(input) },
          { role: 'user', content },
        ],
      }),
      signal: ctx.signal ?? timeoutSignal(),
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return parseGradingResponse(text, input);
  },
  async ping(ctx) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ctx.model || openaiProvider.defaultModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Responde solo: OK' }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(await readError(response));
    return 'Conexión correcta con OpenAI';
  },
};

// ------------------------------------------------------------- Anthropic

const anthropicProvider: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic',
  requiresKey: true,
  keyVariable: 'ANTHROPIC_API_KEY',
  defaultModel: 'claude-sonnet-4-5',
  async evaluate(input, ctx) {
    const content: unknown[] = [{ type: 'text', text: buildUserPrompt(input) }];
    for (const image of input.images) {
      content.push({ type: 'text', text: `— ${image.label} —` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mime, data: image.base64 },
      });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ctx.model || anthropicProvider.defaultModel,
        max_tokens: 3000,
        temperature: 0.2,
        system: buildSystemPrompt(input),
        messages: [{ role: 'user', content }],
      }),
      signal: ctx.signal ?? timeoutSignal(),
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return parseGradingResponse(text, input);
  },
  async ping(ctx) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ctx.model || anthropicProvider.defaultModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Responde solo: OK' }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(await readError(response));
    return 'Conexión correcta con Anthropic';
  },
};

// ---------------------------------------------------------------- Gemini

const geminiProvider: ProviderDefinition = {
  id: 'gemini',
  name: 'Google Gemini',
  requiresKey: true,
  keyVariable: 'GEMINI_API_KEY',
  defaultModel: 'gemini-3.8-flash',
  async evaluate(input, ctx) {
    const parts: unknown[] = [{ text: buildUserPrompt(input) }];
    for (const image of input.images) {
      parts.push({ text: `— ${image.label} —` });
      parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    }
    const model = ctx.model || geminiProvider.defaultModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(input) }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
        signal: ctx.signal ?? timeoutSignal(),
      },
    );
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('\n');
    return parseGradingResponse(text, input);
  },
  async ping(ctx) {
    const model = ctx.model || geminiProvider.defaultModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Responde solo: OK' }] }] }),
        // El free tier de Gemini puede tardar >60 s; margen amplio para no
        // reportar falsos fallos de conexión.
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) throw new Error(await readError(response));
    return 'Conexión correcta con Google Gemini';
  },
};

// --------------------------------------------------------------- Simulado

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRENGTHS = ['bien resuelto', 'correcto pero incompleto', 'con un error de cálculo', 'parcialmente justificado', 'sin justificar el resultado'];

const simuladoProvider: ProviderDefinition = {
  id: 'simulado',
  name: 'Simulado (offline)',
  requiresKey: false,
  keyVariable: null,
  defaultModel: 'simulado-v1',
  async evaluate(input, ctx) {
    const seed = hashString(`${input.seed}:${ctx.model}:${input.activityTitle}`);
    const random = mulberry32(seed);
    const items = input.rubric.map((item) => {
      const ratio = 0.35 + random() * 0.65;
      const points = Math.min(item.maxPoints, Math.round(item.maxPoints * ratio * 10) / 10);
      const strength = STRENGTHS[Math.floor(random() * STRENGTHS.length)];
      return {
        itemId: item.id,
        points,
        comment: `«${item.title}»: ${strength}; se valora la evidencia mostrada en el examen.`,
        confidence: Math.round((0.55 + random() * 0.4) * 100) / 100,
      };
    });
    const total = items.reduce((sum, item) => sum + item.points, 0);
    const max = input.rubric.reduce((sum, item) => sum + item.maxPoints, 0) || 1;
    return {
      reading: [
        `[Proveedor simulado · ${ctx.model}] Lectura del examen (${input.images.length} página(s)).`,
        input.rubric
          .map(
            (item) =>
              `- ${item.title}: se identifica desarrollo manuscrito, cálculos y, en su caso, tabla/gráfico asociado.`,
          )
          .join('\n'),
      ].join('\n'),
      overallComment: `Resultado global ${total.toFixed(1)}/${max.toFixed(1)}. Evaluación generada por el proveedor simulado para pruebas sin conexión.`,
      items,
    };
  },
  async ping() {
    return 'Proveedor simulado disponible';
  },
};

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  simulado: simuladoProvider,
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function getProvider(id: string): ProviderDefinition | null {
  return (PROVIDERS as Record<string, ProviderDefinition>)[id] ?? null;
}

export function providerKey(id: string): { apiKey: string; missingVariable: string | null } {
  if (id === 'simulado') return { apiKey: '', missingVariable: null };
  const provider = getProvider(id);
  if (!provider) return { apiKey: '', missingVariable: 'proveedor desconocido' };
  const variable = provider.keyVariable ?? '';
  const apiKey = process.env[variable] ?? '';
  return { apiKey, missingVariable: apiKey ? null : variable };
}

export async function runProviderEvaluation(
  providerId: string,
  model: string,
  input: GradingInput,
): Promise<GradingOutput> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Proveedor desconocido: ${providerId}`);
  const { apiKey, missingVariable } = providerKey(providerId);
  if (missingVariable) {
    throw new Error(`Falta la variable de entorno ${missingVariable} para usar ${provider.name}`);
  }
  return provider.evaluate(input, { apiKey, model });
}

export async function testProvider(providerId: string, model: string): Promise<string> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Proveedor desconocido: ${providerId}`);
  const { apiKey, missingVariable } = providerKey(providerId);
  if (missingVariable) {
    throw new Error(`Falta la variable de entorno ${missingVariable} para usar ${provider.name}`);
  }
  return provider.ping({ apiKey, model });
}
