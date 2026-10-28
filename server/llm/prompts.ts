import { z } from 'zod';
import type { GradingInput, GradingOutput } from './types';
import type { ScanResult } from '../../shared/types';

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
    '- Antes de puntuar, recorre visualmente TODAS las páginas adjuntas de la entrega y localiza cada pregunta de la rúbrica.',
    '- Para CADA apartado distingue explícitamente: RESPONDIDO, EN BLANCO (la pregunta se ve y no hay respuesta) o NO LOCALIZABLE (no puedes encontrar la pregunta en las páginas recibidas).',
    '- EN BLANCO recibe 0 puntos y el comentario debe comenzar por "EN BLANCO". No confundas una hoja/página en blanco con una pregunta no localizada.',
    '- NO LOCALIZABLE recibe 0 puntos provisionales; no lo presentes como respuesta correcta.',
    '- Solo puedes dar más de 0 puntos si el estado es RESPONDIDO y puedes citar la evidencia visible de la respuesta.',
    '- Si un apartado no aparece en las páginas de la entrega, no afirmes que está en blanco: indícalo como "NO LOCALIZABLE" y puntúa 0 provisionalmente.',
    '- No omitas ningún apartado aunque esté en blanco, no localizado o ilegible; aporta una línea por apartado en reading.',
    '',
    'Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional ni bloques de código, con esta forma:',
    '{"reading":"<transcripción estructurada: por cada apartado, estado RESPONDIDO/EN BLANCO/NO LOCALIZABLE y evidencia visible>",',
    ' "items":[{"itemId":<id numérico de la rúbrica>,"points":<número>,"state":"RESPONDIDO|EN BLANCO|NO LOCALIZABLE","evidence":"<cita textual o descripción exacta de lo visible>","comment":"<comentario>","confidence":<0..1>}],',
    ' "overallComment":"<comentario global breve del examen>"}',
    'Incluye exactamente un objeto items por cada apartado de la rúbrica, usando sus ids.',
    'El campo "evidence" debe citar lo que se ve (texto manuscrito, operación, tabla…) o indicar que no hay respuesta visible.',
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
      'Si una etiqueta indica que faltan páginas, limita tus conclusiones a las páginas recibidas: marca como NO LOCALIZABLE cualquier apartado que pudiera estar en las páginas no adjuntas; nunca lo declares EN BLANCO.',
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
        state: z.enum(['RESPONDIDO', 'EN BLANCO', 'NO LOCALIZABLE']).optional(),
        evidence: z.string().optional().default(''),
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
    const blank = found.state === 'EN BLANCO' || found.state === 'NO LOCALIZABLE';
    const commentParts = [
      found.state ? `[${found.state}]` : '',
      (found.comment ?? '').trim(),
      found.evidence?.trim() ? `Evidencia: ${found.evidence.trim()}` : '',
    ].filter(Boolean);
    return {
      itemId: rubricItem.id,
      points: blank ? 0 : points,
      comment: commentParts.join(' '),
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

// ------------------------------------------------ Verificar lectura del examen

export function buildReadSystemPrompt(subject: string): string {
  return [
    `Eres un transcriptor literal de exámenes manuscritos de ${SUBJECT_LABEL[subject] ?? subject}.`,
    'Tu única tarea es describir con exactitud lo que se ve en las imágenes de la entrega del alumno.',
    'No corrijas, no completes respuestas y no deduzcas lo que el alumno "debería" haber escrito.',
    '',
    'Reglas:',
    '- Recorre cada página completa, incluidos márgenes, recuadros, tachones y zonas vacías.',
    '- Distingue entre pregunta impresa, respuesta manuscrita, marcas (X, círculos, subrayados) y espacios en blanco.',
    '- Usa [ILEGIBLE] cuando no puedas leer algo y [PÁGINA EN BLANCO] cuando no haya contenido.',
    '- Para cada página indica las preguntas visibles, la respuesta visible y su estado: RESPONDIDA, EN BLANCO o NO SE VE.',
    '- Al final incluye un resumen con el número de páginas y las preguntas que no hayas podido localizar.',
    'Responde en español y en texto plano, sin inventar contenido.',
  ].join('\n');
}

export function buildReadUserPrompt(imageCount: number): string {
  return [
    imageCount === 1
      ? 'Adjunto 1 página de la entrega del alumno.'
      : `Adjunto ${imageCount} páginas de la entrega del alumno, en orden.`,
    'Transcribe página por página lo que ves, con este formato:',
    'Página N:',
    '- Preguntas visibles: …',
    '- Respuesta del alumno: …',
    '- Estado: RESPONDIDA / EN BLANCO / NO SE VE',
    'Al final: "Resumen de lectura: …".',
  ].join('\n');
}

// --------------------------------------- Generar plantilla de respuestas (IA)

export function buildSolveSystemPrompt(subject: string): string {
  return [
    `Eres un profesor experto y meticuloso de ${SUBJECT_LABEL[subject] ?? subject}.`,
    'Vas a responder un examen completo tal y como lo respondería un alumno perfecto:',
    'esa respuesta será la plantilla (solución de referencia) con la que se corregirán',
    'los exámenes de los alumnos.',
    '',
    'Reglas:',
    '- Responde CADA apartado del examen, en el mismo orden, con un encabezado por',
    '  apartado (## Apartado N · título).',
    '- Recorre todas las páginas adjuntas antes de redactar y coteja la solución con cada pregunta visible; no omitas apartados aunque estén repetidos, tengan varios incisos o continúen en otra página.',
    '- Si un enunciado o dato no se puede leer, no lo inventes: señala la duda bajo el apartado correspondiente y explica la interpretación asumida.',
    '- Desarrollo completo y riguroso: definiciones, procesos, fórmulas, ejemplos y',
    '  esquemas en texto, con el razonamiento esperado en una respuesta perfecta.',
    '- En exámenes prácticos, muestra el procedimiento paso a paso y el resultado final.',
    '- Añade al final, bajo "Vigilar al corregir", los errores típicos que conviene',
    '  comprobar en las respuestas de los alumnos.',
    '- Escribe en español, en Markdown, sin bloques de código salvo las fórmulas.',
  ].join('\n');
}

export function buildSolveUserPrompt(
  enunciado: string,
  apartados: { title: string; maxPoints: number }[],
  imageCount: number,
): string {
  const parts: string[] = [];
  if (apartados.length > 0) {
    parts.push(
      'Apartados del examen (de la rúbrica):',
      JSON.stringify(apartados, null, 2),
      '',
    );
  }
  if (enunciado.trim()) {
    parts.push('Enunciado (texto):', enunciado.trim().slice(0, 12000), '');
  }
  if (imageCount > 0) {
    parts.push(
      imageCount === 1
        ? 'Adjunto 1 imagen del examen: léela completa antes de responder.'
        : `Adjunto ${imageCount} imágenes del examen, en orden de lectura: léelas completas antes de responder.`,
    );
  } else {
    parts.push('No se adjuntan imágenes; responde solo con el texto del enunciado.');
  }
  parts.push('', 'Responde el examen completo como plantilla de corrección.');
  return parts.join('\n');
}

// ------------------------------------------------------------------ Escáner

export function buildScanSystemPrompt(esperado: 'auto' | 'examen' | 'lista'): string {
  const focus =
    esperado === 'lista'
      ? 'Se espera una LISTA DE ALUMNOS (acta de matrícula, hoja de clase…): extrae los NOMBRES.'
      : esperado === 'examen'
        ? 'Se espera un EXAMEN o práctica: extrae el enunciado y los apartados con su puntuación.'
        : 'Puede ser un examen, una lista de alumnos u otro documento: identifica primero qué es.';
  return [
    'Eres un extractor de información de documentos escaneados o fotografiados (OCR con comprensión).',
    focus,
    'Lee con cuidado el texto manuscrito e impreso. No inventes contenido: si algo no se ve o no aplica,',
    'déjalo vacío y explícalo brevemente en "observaciones".',
    '',
    'Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto adicional ni bloques de código, con esta forma:',
    '{"tipo":"examen|lista|otro",',
    ' "titulo":"<título del examen o documento>",',
    ' "asignatura":"biologia|bioquimica|otro",',
    ' "enunciado":"<texto completo del enunciado o preguntas, con saltos de línea>",',
    ' "apartados":[{"titulo":"<apartado>","descripcion":"<qué valora>","puntos":<número>}],',
    ' "nombres":["<nombre completo del alumno>", …],',
    ' "observaciones":"<nota breve>"}',
    'Reglas: los nombres completos sin numeración ni separadores CSV; los "puntos" con decimal;',
    'si el documento no es ni examen ni lista, usa tipo "otro" y deja vacíos el resto de campos.',
  ].join('\n');
}

export function buildScanUserPrompt(
  esperado: 'auto' | 'examen' | 'lista',
  imageCount: number,
  contexto?: string,
): string {
  const parts: string[] = [];
  if (imageCount === 0) {
    parts.push('No se adjuntan imágenes: trabaja solo con el texto aportado.');
  } else if (imageCount === 1) {
    parts.push('Adjunto 1 imagen del documento a escanear.');
  } else {
    parts.push(`Adjunto ${imageCount} imágenes del documento, en orden de lectura.`);
  }
  if (contexto?.trim()) {
    parts.push(
      '',
      'Material de la actividad (enunciado, solución/plantilla y criterios, si existen):',
      contexto.trim().slice(0, 16000),
      '',
      'Al definir "apartados" para la corrección, básate en este material y en las preguntas visibles.',
      'Agrupa las preguntas tipo test o los incisos menores en bloques corregibles, en lugar de crear',
      'un apartado por pregunta si hay muchas. Mantén la puntuación original cuando aparezca; si no,',
      'reparte una puntuación razonable. Cada apartado debe describir qué debe demostrar el alumno.',
    );
  }
  parts.push('Devuelve únicamente el JSON indicado.');
  if (esperado !== 'auto') parts.push('Recuerda el tipo de documento esperado indicado antes.');
  return parts.filter(Boolean).join('\n');
}

export const scanResponseSchema = z.object({
  tipo: z.enum(['examen', 'lista', 'otro']).default('otro'),
  titulo: z.string().optional().default(''),
  asignatura: z.string().optional().default(''),
  enunciado: z.string().optional().default(''),
  apartados: z
    .array(
      z.object({
        titulo: z.string().optional().default(''),
        descripcion: z.string().optional().default(''),
        puntos: z.number().optional().default(1),
      }),
    )
    .max(20)
    .default([]),
  nombres: z.array(z.string()).max(80).default([]),
  observaciones: z.string().optional().default(''),
});

export function parseScanResponse(text: string): ScanResult {
  const parsed = scanResponseSchema.parse(extractJsonObject(text));
  const apartados = parsed.apartados
    .map((item, index) => ({
      title: (item.titulo || `Apartado ${index + 1}`).trim().slice(0, 200),
      description: item.descripcion.trim().slice(0, 4000),
      maxPoints: Math.min(1000, Math.max(0.5, Math.round((item.puntos || 1) * 10) / 10)),
    }))
    .slice(0, 20);
  const nombres = Array.from(
    new Set(
      parsed.nombres
        .map((name) => name.replace(/^\s*\d+[).\-\s]+/, '').trim())
        .filter((name) => name.length > 2 && name.length <= 120),
    ),
  );
  return {
    tipo: parsed.tipo,
    titulo: parsed.titulo.trim().slice(0, 200),
    asignatura: parsed.asignatura.trim().toLowerCase().slice(0, 40),
    enunciado: parsed.enunciado.trim().slice(0, 12000),
    apartados,
    nombres,
    observaciones: parsed.observaciones.trim().slice(0, 1000),
  };
}
