import { describe, expect, it } from 'vitest';
import { expandPdfFiles, isPdfFile } from './pdf';

describe('conversión de PDF en el navegador', () => {
  it('detecta PDFs por tipo o por extensión', () => {
    expect(isPdfFile(new File(['x'], 'examen.pdf', { type: 'application/octet-stream' }))).toBe(true);
    expect(isPdfFile(new File(['x'], 'foto.jpg', { type: 'image/jpeg' }))).toBe(false);
  });

  it('deja pasar las imágenes sin cargar PDF.js', async () => {
    const image = new File(['x'], 'foto.png', { type: 'image/png' });
    await expect(expandPdfFiles([image])).resolves.toEqual([image]);
  });
});
