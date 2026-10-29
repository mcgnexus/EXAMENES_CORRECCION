import { useEffect, useRef, useState } from 'react';

interface CropRect { x: number; y: number; width: number; height: number }
interface Edit { rotation: number; brightness: number; contrast: number; crop: CropRect | null }
interface Entry { file: File; url: string; image: HTMLImageElement; edit: Edit }

const DEFAULT_EDIT: Edit = { rotation: 0, brightness: 1, contrast: 1, crop: null };
const PREVIEW_WIDTH = 860;
const PREVIEW_HEIGHT = 520;
const MAX_EDGE = 2200;

function cropOf(image: HTMLImageElement, crop: CropRect | null): CropRect {
  return crop ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
}

/** Dibuja la región recortada y rotada en un canvas al tamaño indicado. */
function drawEdited(
  canvas: HTMLCanvasElement,
  entry: Entry,
  maxWidth: number,
): void {
  const region = cropOf(entry.image, entry.edit.crop);
  const swap = entry.edit.rotation % 180 !== 0;
  const scale = Math.min(1, maxWidth / (swap ? region.height : region.width));
  canvas.width = Math.max(1, Math.round((swap ? region.height : region.width) * scale));
  canvas.height = Math.max(1, Math.round((swap ? region.width : region.height) * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale((canvas.width / (swap ? region.height : region.width)), canvas.height / (swap ? region.width : region.height));
  ctx.translate((swap ? region.height : region.width) / 2, (swap ? region.width : region.height) / 2);
  ctx.rotate((entry.edit.rotation * Math.PI) / 180);
  ctx.filter = `brightness(${entry.edit.brightness}) contrast(${entry.edit.contrast})`;
  ctx.drawImage(
    entry.image,
    region.x, region.y, region.width, region.height,
    -region.width / 2, -region.height / 2, region.width, region.height,
  );
  ctx.restore();
}

export default function ImageRetouch({ files, onCancel, onApply }: {
  files: File[];
  onCancel: () => void;
  onApply: (files: File[]) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cropStart = useRef<{ x: number; y: number } | null>(null);
  const current = entries[index];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: Entry[] = [];
      for (const file of files) {
        const url = URL.createObjectURL(file);
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`No se ha podido leer «${file.name}»`));
          image.src = url;
        });
        if (cancelled) { URL.revokeObjectURL(url); return; }
        loaded.push({ file, url, image, edit: { ...DEFAULT_EDIT } });
      }
      if (!cancelled) setEntries(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);
  useEffect(() => () => { for (const e of entries) URL.revokeObjectURL(e.url); }, [entries]);

  useEffect(() => {
    if (current && canvasRef.current) drawEdited(canvasRef.current, current, PREVIEW_WIDTH);
  }, [current]);

  const update = (patch: Partial<Edit>) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, edit: { ...e.edit, ...patch } } : e)));
  };

  function canvasPoint(event: React.MouseEvent): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = current!.image.naturalWidth / rect.width;
    return {
      x: Math.max(0, Math.min(current!.image.naturalWidth, (event.clientX - rect.left) * scale)),
      y: Math.max(0, Math.min(current!.image.naturalHeight, (event.clientY - rect.top) * scale)),
    };
  }

  function onCropStart(event: React.MouseEvent) {
    if (!current || current.edit.rotation % 180 !== 0) return;
    cropStart.current = canvasPoint(event);
    update({ crop: null });
  }
  function onCropMove(event: React.MouseEvent) {
    if (!cropStart.current || !current) return;
    const point = canvasPoint(event);
    const start = cropStart.current;
    update({
      crop: {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      },
    });
  }
  function onCropEnd() {
    cropStart.current = null;
    setEntries((prev) => prev.map((e, i) => {
      if (i !== index || !e.edit.crop) return e;
      const { crop } = e.edit;
      // Descarta selecciones accidentales mínimas.
      if (crop.width < e.image.naturalWidth * 0.05 || crop.height < e.image.naturalHeight * 0.05) {
        return { ...e, edit: { ...e.edit, crop: null } };
      }
      return e;
    }));
  }

  async function apply() {
    if (!entries.length) return;
    setApplying(true);
    setError('');
    try {
      const result: File[] = [];
      for (const entry of entries) {
        const canvas = document.createElement('canvas');
        // Exporta a resolución alta: limita el borde mayor para no inflar la subida.
        const region = cropOf(entry.image, entry.edit.crop);
        const swap = entry.edit.rotation % 180 !== 0;
        const long = Math.max(swap ? region.height : region.width, swap ? region.width : region.height);
        drawEdited(canvas, entry, Math.min(MAX_EDGE, long));
        const type = entry.file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), type, type === 'image/jpeg' ? 0.92 : undefined),
        );
        if (!blob) throw new Error(`No se ha podido procesar «${entry.file.name}»`);
        result.push(new File([blob], entry.file.name, { type }));
      }
      onApply(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar las imágenes');
    } finally {
      setApplying(false);
    }
  }

  if (!current) {
    return <div className="notice">Cargando imágenes…</div>;
  }
  const rotatable = current.edit.rotation % 180 === 0;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.65)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: 24 }}>
      <section className="card" style={{ maxWidth: PREVIEW_WIDTH + 48, width: '100%' }} aria-label="Editor de retoque de la foto">
        <h2>Retocar foto antes de subir</h2>
        <p className="small muted">
          {files.length > 1 ? `Foto ${index + 1} de ${files.length} · ` : ''}
          Mejora la legibilidad para el detector de burbujas: endereza, ajusta luz y recorta lo que sobra.
          Recorta antes de rotar. La foto retocada es la que se guarda y analiza.
        </p>
        {files.length > 1 && <div className="row">
          <button className="btn" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>◀ Anterior</button>
          <button className="btn" disabled={index === entries.length - 1} onClick={() => setIndex((i) => Math.min(entries.length - 1, i + 1))}>Siguiente ▶</button>
          <span className="small muted">{current.file.name}</span>
        </div>}
        <div style={{ border: '1px solid #cbd5e1', display: 'inline-block', maxWidth: '100%', cursor: rotatable ? 'crosshair' : 'default' }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
            onMouseDown={onCropStart}
            onMouseMove={onCropMove}
            onMouseUp={onCropEnd}
            onMouseLeave={onCropEnd}
          />
        </div>
        {current.edit.crop && rotatable && (
          <p className="small muted">Recorte: {Math.round(current.edit.crop.width)}×{Math.round(current.edit.crop.height)} px <button className="btn small" onClick={() => update({ crop: null })}>Quitar recorte</button></p>
        )}
        {!rotatable && <p className="small muted">Con la foto rotada no se puede recortar: pulsa «Restablecer» para recortar primero.</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => update({ rotation: (current.edit.rotation + 270) % 360 })}>Rotar ⟲</button>
          <button className="btn" onClick={() => update({ rotation: (current.edit.rotation + 90) % 360 })}>Rotar ⟳</button>
          <label className="field">Brillo
            <input type="range" min="0.5" max="1.5" step="0.05" value={current.edit.brightness} onChange={(e) => update({ brightness: Number(e.target.value) })} />
          </label>
          <label className="field">Contraste
            <input type="range" min="0.5" max="1.5" step="0.05" value={current.edit.contrast} onChange={(e) => update({ contrast: Number(e.target.value) })} />
          </label>
          <button className="btn" onClick={() => update({ ...DEFAULT_EDIT })}>Restablecer</button>
        </div>
        {error && <p role="alert" className="notice">{error}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={applying} onClick={() => void apply()}>
            {applying ? 'Procesando…' : `Aplicar y subir ${files.length > 1 ? `${files.length} fotos` : 'la foto'}`}
          </button>
          <button className="btn" onClick={onCancel} disabled={applying}>Cancelar</button>
        </div>
      </section>
    </div>
  );
}
