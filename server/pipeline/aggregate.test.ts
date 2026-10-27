import { describe, expect, it } from 'vitest';
import { effectiveThreshold, isDivergent, median, proposeGrade, round1 } from './aggregate';

describe('agregación de evaluaciones', () => {
  it('calcula la mediana con y sin número par de valores', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('redondea a una décima', () => {
    expect(round1(2.44)).toBe(2.4);
    expect(round1(2.45)).toBe(2.5);
  });

  it('limita el umbral al 20% del máximo del apartado', () => {
    expect(effectiveThreshold(1, 2.5)).toBe(0.5);
    expect(effectiveThreshold(1, 10)).toBe(1);
    expect(effectiveThreshold(0.1, 0.5)).toBe(0.1);
    expect(effectiveThreshold(1, 0.5)).toBe(0.2);
  });

  it('detecta divergencia por encima del umbral efectivo', () => {
    expect(isDivergent([1.0, 1.4], 1, 2.5)).toBe(false);
    expect(isDivergent([1.0, 2.0], 1, 2.5)).toBe(true);
    expect(isDivergent([2.0], 1, 2.5)).toBe(false);
  });

  it('propone la mediana por apartado y usa el comentario del primario', () => {
    const rubric = [
      { id: 1, maxPoints: 2.5 },
      { id: 2, maxPoints: 2.5 },
    ];
    const proposed = proposeGrade(
      rubric,
      [
        {
          role: 'primary',
          status: 'done',
          overallComment: 'Global primario',
          items: [
            { rubricItemId: 1, points: 2.0, comment: 'Comentario primario' },
            { rubricItemId: 2, points: 1.0, comment: '' },
          ],
        },
        {
          role: 'independent',
          status: 'done',
          overallComment: '',
          items: [
            { rubricItemId: 1, points: 1.0, comment: 'Otro' },
            { rubricItemId: 2, points: 2.0, comment: 'Independiente' },
          ],
        },
      ],
      1,
    );

    expect(proposed.items[0].points).toBe(1.5);
    expect(proposed.items[0].comment).toBe('Comentario primario');
    expect(proposed.items[0].divergent).toBe(true);
    expect(proposed.items[1].points).toBe(1.5);
    expect(proposed.total).toBe(3);
    expect(proposed.overallComment).toBe('Global primario');
  });

  it('ignora evaluaciones con error y acota al máximo del apartado', () => {
    const proposed = proposeGrade(
      [{ id: 1, maxPoints: 2 }],
      [
        {
          role: 'primary',
          status: 'error',
          overallComment: 'no debe usarse',
          items: [{ rubricItemId: 1, points: 2, comment: 'x' }],
        },
        {
          role: 'independent',
          status: 'done',
          overallComment: '',
          items: [{ rubricItemId: 1, points: 5, comment: 'por encima' }],
        },
      ],
      1,
    );
    expect(proposed.items[0].points).toBe(2);
    expect(proposed.overallComment).toBe('');
  });
});
