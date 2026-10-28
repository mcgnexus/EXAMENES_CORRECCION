import { describe, expect, it } from 'vitest';
import { buildSolveSystemPrompt, buildSystemPrompt, normalizeModelOutput } from './prompts';
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

  it('pide una solución de referencia completa y señala ambigüedades', () => {
    const prompt = buildSolveSystemPrompt('biologia');
    expect(prompt).toContain('no omitas apartados');
    expect(prompt).toContain('no lo inventes');
  });
});
