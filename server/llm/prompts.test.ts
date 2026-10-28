import { describe, expect, it } from 'vitest';
import {
  buildReadSystemPrompt,
  buildReadUserPrompt,
  buildScanUserPrompt,
  buildSolveSystemPrompt,
  buildSystemPrompt,
  normalizeModelOutput,
  parseScanResponse,
} from './prompts';
import type { GradingInput } from './types';

const gradingInput: GradingInput = {
  subject: 'biologia',
  activityTitle: 'Examen de prueba',
  activityDescription: '',
  rubric: [
    { id: 1, title: 'Pregunta 1', description: '', maxPoints: 2 },
    { id: 2, title: 'Pregunta 2', description: '', maxPoints: 2 },
  ],
  documentText: '',
  solutionText: '',
  images: [],
  seed: 1,
};

describe('instrucciones de evaluación por apartado', () => {
  it('exige distinguir preguntas en blanco de las no localizables', () => {
    const prompt = buildSystemPrompt(gradingInput);
    expect(prompt).toContain('EN BLANCO');
    expect(prompt).toContain('NO LOCALIZABLE');
    expect(prompt).toContain('No omitas ningún apartado');
  });

  it('rellena con cero y diagnóstico los apartados omitidos por el modelo', () => {
    const result = normalizeModelOutput(
      { reading: '', overallComment: '', items: [{ itemId: 1, points: 1, comment: 'Correcta' }] },
      gradingInput,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({
      itemId: 2,
      points: 0,
      comment: 'El modelo no devolvió una puntuación para este apartado.',
    });
  });

  it('fuerza 0 puntos cuando el apartado está en blanco y guarda la evidencia', () => {
    const result = normalizeModelOutput(
      {
        reading: '',
        overallComment: '',
        items: [
          {
            itemId: 1,
            points: 1.5,
            state: 'EN BLANCO',
            evidence: 'La pregunta 1 no tiene respuesta manuscrita.',
            comment: 'Sin respuesta.',
          },
        ],
      },
      gradingInput,
    );
    expect(result.items[0].points).toBe(0);
    expect(result.items[0].comment).toContain('[EN BLANCO]');
    expect(result.items[0].comment).toContain('Evidencia: La pregunta 1');
  });

  it('pide una solución de referencia completa y señala ambigüedades', () => {
    const prompt = buildSolveSystemPrompt('biologia');
    expect(prompt).toContain('no omitas apartados');
    expect(prompt).toContain('no lo inventes');
  });
});

describe('verificación de lectura', () => {
  it('pide transcripción literal sin corregir ni inventar', () => {
    const system = buildReadSystemPrompt('biologia');
    expect(system).toContain('No corrijas');
    expect(system).toContain('[PÁGINA EN BLANCO]');
    const user = buildReadUserPrompt(2);
    expect(user).toContain('Página N');
    expect(user).toContain('Estado: RESPONDIDA');
  });
});

describe('propuesta de rúbrica a partir del material', () => {
  it('incluye el enunciado y la plantilla en el contexto del escaneo', () => {
    const prompt = buildScanUserPrompt('examen', 0, 'Pregunta 1: glucólisis\nSolución: 10 pasos');
    expect(prompt).toContain('glucólisis');
    expect(prompt).toContain('Solución: 10 pasos');
    expect(prompt).toContain('bloques corregibles');
  });

  it('normaliza los apartados propuestos por el modelo', () => {
    const result = parseScanResponse(
      JSON.stringify({
        tipo: 'examen',
        apartados: [
          { titulo: 'Bloque 1 · preguntas 1-10', descripcion: 'Metabolismo', puntos: 3 },
          { titulo: '', descripcion: 'Sin título', puntos: 0 },
        ],
      }),
    );
    expect(result.apartados).toHaveLength(2);
    expect(result.apartados[0]).toMatchObject({ title: 'Bloque 1 · preguntas 1-10', maxPoints: 3 });
    expect(result.apartados[1].title).toBe('Apartado 2');
    expect(result.apartados[1].maxPoints).toBeGreaterThan(0);
  });
});
