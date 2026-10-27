# Exámenes · Corrección asistida por varios LLM

Aplicación **privada y local** para que un profesor de Biología y Bioquímica cree actividades,
suba exámenes manuscritos (fotos o PDF), obtenga una propuesta de corrección por apartado,
la contraste con evaluaciones independientes de varios LLM y apruebe/exporte la calificación.

Los metadatos (clases, actividades, notas) viven en **PostgreSQL** (`DATABASE_URL`) y los
archivos de los alumnos en `./data`. No hay servidor propio, cuentas de alumnos, facturación
ni entrenamiento de modelos.

## Recorrido cubierto

1. **Clase** con ~30 alumnos (alta manual o importación de lista/CSV).
2. **Actividad** de Biología o Bioquímica con **rúbrica por apartados** y documentos:
   enunciado, solución, rúbrica y documentación.
3. **Entregas**: fotos o PDF por alumno (los PDF se convierten a páginas PNG con `pdftoppm`).
4. **Lote de hasta 10 entregas** procesado en segundo plano con progreso.
5. **Propuesta primaria** por apartado (modelo configurable).
6. **Evaluaciones independientes** de varios LLM, cada una sin ver la propuesta.
7. **Comparación** apartado × modelo con detección de divergencias.
8. **Revisión humana**: visor de páginas, edición de puntos/comentarios, aprobación.
9. **Exportación**: CSV del acta (calificaciones y comentarios) y PDF de corrección por alumno.

## Requisitos

- Node.js 20+ y npm.
- Una base de **PostgreSQL** (Neon, RDS, local o Docker) con su `DATABASE_URL`.
- `pdftoppm` (poppler-utils) para convertir PDF a imágenes. En Debian/Ubuntu:
  `sudo apt install poppler-utils`.
- Claves de API **opcionales**. Sin claves, la app funciona con el proveedor **`simulado`**,
  que genera correcciones deterministas en español para probar el recorrido completo sin red.

## Instalación y arranque

```bash
npm install
cp .env.example .env      # define DATABASE_URL (obligatoria) y, si quieres, claves LLM
npm run dev               # API en :8787 + interfaz Vite en http://localhost:5173
```

Modo producción local (un solo proceso, sirve la interfaz ya compilada):

```bash
npm run build
npm start                 # http://127.0.0.1:8787
```

La app escucha solo en `127.0.0.1` por defecto. Cambia `HOST`/`PORT` en `.env` si lo necesitas.

## Configurar los LLM

En **Ajustes y LLM**:

- **Modelo primario**: genera la propuesta de corrección por apartado.
- **Evaluadores independientes** (recomendado ≥2): evalúan el mismo examen sin ver la propuesta.
- **Umbral de divergencia**: si los modelos difieren más de ese margen (acotado al 20 % del
  máximo del apartado), el apartado se marca en rojo para revisión.
- **Concurrencia** del lote e **imágenes por evaluación** (control de cuota).

Proveedores incluidos: OpenAI, Anthropic, Google Gemini y simulado. Las claves se leen de
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` y `GEMINI_API_KEY`. El botón *Probar conexión* hace una
llamada mínima.

### Privacidad

- Los metadatos residen en tu base de datos PostgreSQL (`DATABASE_URL`); los exámenes
  (originales y páginas PNG) quedan en `./data` (excluido de git).
- Los prompts envían **seudónimos** (Alumno A, B…), nunca nombres ni correos.
- Las **imágenes** sí se envían al proveedor en la nube configurado. Si no quieres que salgan
  del equipo, usa solo el proveedor `simulado`.
- La aprobación siempre es humana; ningún modelo aprueba solo.

## Datos y copias de seguridad

- Base de datos: **PostgreSQL** vía `DATABASE_URL` (tablas creadas automáticamente al arrancar).
- `data/files/` — originales y páginas PNG de los exámenes (excluido de git).
- Para respaldar, exporta la base de datos (pg_dump) y copia `data/` con la app parada.
- `npm run acceptance` usa un esquema PostgreSQL dedicado (`PG_SCHEMA`) que se elimina solo
  al terminar: no deja datos en tu base real.

## Verificación

```bash
npm run typecheck   # o npm run lint
npm test            # unitarios: agregación, divergencias, CSV, proveedor simulado
npm run acceptance  # recorrido E2E completo sin red (38 comprobaciones)
```

`npm run acceptance` crea una clase con 30 alumnos, una actividad con 4 apartados y sus
documentos, sube dos exámenes, lanza el lote con proveedores simulados, edita y aprueba una
corrección, y comprueba el CSV y el PDF exportados. Usa un directorio temporal y no toca tus datos.

## Estructura

```
server/            Fastify: rutas, PostgreSQL, almacenamiento, proveedores LLM, cola y exportación
  db.ts            pool de pg, migraciones, ajustes
  llm/             OpenAI, Anthropic, Gemini, simulado + prompts
  pipeline/        cola de lotes, corrección por entrega, agregación
  export/          CSV y PDF con pdfkit
client/            React + Vite (SPA en español)
shared/types.ts    Tipos compartidos
scripts/           Recorrido de aceptación
data/              Archivos locales (no versionado)
```

## Límites conocidos

- Un lote admite como máximo **10 entregas** (validado en cliente y servidor).
- Lectura de manuscritos: depende del modelo de visión. Los apartados ilegibles se marcan y
  puntúan de forma conservadora; la revisión humana es obligatoria.
- Si la app se reinicia a mitad de un lote, las entregas en curso quedan como `error` y pueden
  relanzarse.
- Fuera de alcance por ahora: integración con plataformas universitarias, cuentas de alumnos,
  facturación y entrenamiento de modelos.
