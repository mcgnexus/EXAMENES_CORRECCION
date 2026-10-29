export interface Point { x: number; y: number }

/** Los 7 puntos de calibración, en orden: 4 referencias + 3 anclas de burbujas. */
export const CALIBRATION_LABELS = [
  'cuadrado superior izquierdo',
  'cuadrado superior derecho',
  'cuadrado inferior izquierdo',
  'cuadrado inferior derecho',
  'primera opción de la primera fila del bloque',
  'última opción de la primera fila del bloque',
  'primera opción de la última fila del bloque',
];

/** Interpola bilinealmente un punto unitario (0..1) sobre las 4 referencias. */
export function project(p: Point, corners: Point[]): Point {
  const [tl, tr, bl, br] = corners;
  return {
    x: (1 - p.y) * ((1 - p.x) * tl.x + p.x * tr.x) + p.y * ((1 - p.x) * bl.x + p.x * br.x),
    y: (1 - p.y) * ((1 - p.x) * tl.y + p.x * tr.y) + p.y * ((1 - p.x) * bl.y + p.y * br.y),
  };
}

/** Inversa numérica de project: coordenada de la foto → espacio unitario de la plantilla. */
export function unproject(target: Point, corners: Point[]): Point {
  let p = { x: 0.5, y: 0.5 };
  for (let i = 0; i < 20; i++) {
    const v = project(p, corners);
    const a = project({ x: p.x + 0.0001, y: p.y }, corners);
    const b = project({ x: p.x, y: p.y + 0.0001 }, corners);
    const ax = (a.x - v.x) / 0.0001;
    const ay = (a.y - v.y) / 0.0001;
    const bx = (b.x - v.x) / 0.0001;
    const by = (b.y - v.y) / 0.0001;
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-8) {
      throw new Error('Referencias inválidas: vuelve a seleccionar las cuatro esquinas.');
    }
    const dx = target.x - v.x;
    const dy = target.y - v.y;
    p = { x: p.x + (dx * by - dy * bx) / det, y: p.y + (dy * ax - dx * ay) / det };
  }
  return p;
}

/** Valida el orden de las 4 referencias y devuelve {tl,tr,bl,br}. */
export function orderedCorners(points: Point[]): [Point, Point, Point, Point] {
  const [tl, tr, bl, br] = points;
  if (!(tl.x < tr.x && bl.x < br.x && tl.y < bl.y && tr.y < br.y)) {
    throw new Error('Orden de referencias inválido.');
  }
  return [tl, tr, bl, br];
}
