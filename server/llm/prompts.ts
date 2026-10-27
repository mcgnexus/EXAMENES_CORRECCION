import { z } from 'zod';
import type { GradingInput, GradingOutput } from './types';

export const SUBJECT_LABEL: Record<string, string> = {
  biologia: 'Biología',
  bioquimica: 'Bioquímica',
};

export function buildSystemPrompt(input: GradingInput): string {
  return [
    `Eres un corrector experto y riguroso de exámenes universitarios de ${SUBJECT_LABEL[input.subject] ?? input.subject}.`,
    'Corriges exámenes manuscritos escaneados o fotografiados. Debes interpretar con cuidado:',
    'texto manuscrito, cálculos, tablas, gráficos y dibujos. Si algo es ilegible, indícalo',
    'explícitamente en el comentario y puntúa de forma conservadora, nunca inventes contenido.',
    '',
    'Reglas de corrección:',
    '- Evalúa CADA apartado de la rúbrica de forma independiente, comparando la respuesta del alumno',
    '  con el enunciado, la solución de referencia y los criterios de la rúbrica.',
    '- Los puntos deben estar entre 0 y el máximo del apartado, con un decimal (0.1).',
    '- Comentarios breves (1-3 frases), concretos y en español, citando la evidencia del examen.',
    '- No penalices dos veces el mismo error dentro del mismo apartado.',
    '- Si no hay evidencia suficiente para un apartado, puntúa 0 e indícalo como no respondido.',
    '',
    'Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional ni bloques de código, con esta forma:',
    '{"reading":"<transcripción estructurada de lo que ves en el examen: por apartado, texto, cálculos, tablas y dibujos>",',
    ' "items":[{"itemId":<id numérico de la rúbrica>,"points":<número>,"comment":"<comentario>","confidence":<0..1>}],',
    ' "overallComment":"<comentario global breve del examen>"}',
    'Incluye exactamente un objeto items por cada apartado de la rúbrica, usando sus ids.',
  ].join('\n');
}

export function buildUserPrompt(input: GradingInput): string {
  const rubric = input.rubric.map((item) => ({
    itemId: item.id,
    title: item.title,
    criteria: item.description,
    maxPoints: item.maxPoints,
  }));

  const parts: string[] = [
    `Actividad: ${input.activityTitle}`,
    input.activityDescription ? `Descripción: ${input.activityDescription}` : '',
    '',
    'Rúbrica (apartados):',
    JSON.stringify(rubric, null, 2),
  ];

  if (input.documentText.trim()) {
    parts.push('', 'Enunciado (texto):', input.documentText.trim().slice(0, 12000));
  }
  if (input.solutionText.trim()) {
    parts.push('', 'Solución de referencia (texto):', input.solutionText.trim().slice(0, 12000));
  }
  if (input.images.length > 0) {
    parts.push(
      '',
      'Las imágenes adjuntas, en orden, son:',
      ...input.images.map((image, index) => `${index + 1}. ${image.label}`),
    );
  } else {
    parts.push('', 'No se adjuntan imágenes; evalúa solo con el texto disponible.');
  }
  parts.push('', 'Devuelve únicamente el JSON indicado.');
  return parts.filter((part) => part !== '').join('\n');
}

export const modelResponseSchema = z.object({
  reading: z.string().optional().default(''),
  overallComment: z.string().optional().default(''),
  items: z
    .array(
      z.object({
        itemId: z.number(),
        points: z.number(),
        comment: z.string().optional().default(''),
        confidence: z.number().nullable().optional().default(null),
      }),
    )
    .default([]),
});

export function extractJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('La respuesta del modelo no contiene un JSON válido');
  }
}

export function normalizeModelOutput(
  raw: unknown,
  input: GradingInput,
): GradingOutput {
  const parsed = modelResponseSchema.parse(raw);
  const byId = new Map(parsed.items.map((item) => [item.itemId, item]));
  const items = input.rubric.map((rubricItem) => {
    const found = byId.get(rubricItem.id);
    if (!found) {
      return {
        itemId: rubricItem.id,
        points: 0,
        comment: 'El modelo no devolvió una puntuación para este apartado.',
        confidence: null,
      };
    }
    const points = Math.min(rubricItem.maxPoints, Math.max(0, Math.round(found.points * 10) / 10));
    return {
      itemId: rubricItem.id,
      points,
      comment: (found.comment ?? '').trim(),
      confidence:
        typeof found.confidence === 'number'
          ? Math.min(1, Math.max(0, found.confidence))
          : null,
    };
  });

  return {
    reading: parsed.reading.trim(),
    overallComment: parsed.overallComment.trim(),
    items,
  };
}
