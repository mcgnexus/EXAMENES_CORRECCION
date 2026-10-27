import { describe, expect, it } from 'vitest';
import { buildCsv, csvEscape } from './csv';

describe('exportación CSV', () => {
  it('escapa comillas, punto y coma y saltos de línea', () => {
    expect(csvEscape('normal')).toBe('normal');
    expect(csvEscape('con ; punto y coma')).toBe('"con ; punto y coma"');
    expect(csvEscape('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvEscape('linea1\nlinea2')).toBe('"linea1\nlinea2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(2.5)).toBe('2.5');
  });

  it('genera un CSV con BOM, separador ; y CRLF', () => {
    const csv = buildCsv([
      ['Alumno', 'Nota (%)'],
      ['Ana; Pérez', 85],
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Alumno;Nota (%)');
    expect(csv).toContain('"Ana; Pérez";85');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
