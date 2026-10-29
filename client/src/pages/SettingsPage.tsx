import { useEffect, useState } from 'react';
import type { AppSettings, ProviderConfig, ProviderInfo } from '../../../shared/types';
import { apiGet, apiSend, errorMessage } from '../api';

interface SettingsResponse {
  settings: AppSettings;
  providers: ProviderInfo[];
  maxBatch: number;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [maxBatch, setMaxBatch] = useState(10);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});

  useEffect(() => {
    apiGet<SettingsResponse>('/api/settings')
      .then((data) => {
        setSettings(data.settings);
        setProviders(data.providers);
        setMaxBatch(data.maxBatch);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  function providerInfo(id: string): ProviderInfo | undefined {
    return providers.find((provider) => provider.id === id);
  }

  function defaultModel(id: string): string {
    return providerInfo(id)?.defaultModel ?? '';
  }

  function updatePrimary(next: Partial<ProviderConfig>) {
    if (!settings) return;
    setSettings({ ...settings, primary: { ...settings.primary, ...next } });
  }

  function updateIndependent(index: number, next: Partial<ProviderConfig>) {
    if (!settings) return;
    const independent = settings.independent.map((config, position) =>
      position === index ? { ...config, ...next } : config,
    );
    setSettings({ ...settings, independent });
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const data = await apiSend<{ settings: AppSettings }>('/api/settings', 'PUT', settings);
      setSettings(data.settings);
      setNotice('Ajustes guardados');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test(config: ProviderConfig, key: string) {
    setTests((current) => ({ ...current, [key]: 'Probando…' }));
    try {
      const result = await apiSend<{ ok: boolean; message: string }>('/api/settings/test', 'POST', config);
      setTests((current) => ({ ...current, [key]: `${result.ok ? '✓' : '✗'} ${result.message}` }));
    } catch (err) {
      setTests((current) => ({ ...current, [key]: `✗ ${errorMessage(err)}` }));
    }
  }

  if (!settings) {
    return error ? <div className="notice">{error}</div> : <div className="empty">Cargando ajustes…</div>;
  }

  const providerSelect = (value: string, onChange: (id: string) => void) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {providers.map((provider) => (
        <option key={provider.id} value={provider.id}>
          {provider.name}
          {provider.available ? '' : ' (sin clave)'}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ajustes y LLM</h1>
          <p className="sub">
            Modelo primario, evaluadores independientes y parámetros del lote de corrección.
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={save} disabled={busy}>
            Guardar ajustes
          </button>
        </div>
      </div>

      {error && <div className="notice" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="grid three" style={{ marginBottom: 16 }}>
        {providers.map((provider) => (
          <div className="card" key={provider.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{provider.name}</strong>
              <span className={`badge ${provider.available ? 'approved' : 'error'}`}>
                {provider.available ? 'disponible' : 'sin clave'}
              </span>
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>
              {provider.requiresKey
                ? `Variable: ${provider.keyVariable}`
                : 'No requiere red ni clave.'}
            </p>
            <p className="small muted">Modelo por defecto: {provider.defaultModel}</p>
          </div>
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Modelo primario (propuesta de corrección)</h2>
        </div>
        <div className="grid three">
          <label className="field">
            Proveedor
            {providerSelect(settings.primary.provider, (id) =>
              updatePrimary({ provider: id, model: defaultModel(id) }),
            )}
          </label>
          <label className="field">
            Modelo
            <input
              value={settings.primary.model}
              onChange={(event) => updatePrimary({ model: event.target.value })}
            />
          </label>
          <div className="stack" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn"
              onClick={() => void test(settings.primary, 'primary')}
            >
              Probar conexión
            </button>
            {tests.primary && <span className="small muted">{tests.primary}</span>}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Evaluaciones independientes</h2>
          <button
            className="btn"
            disabled={settings.independent.length >= 1}
            onClick={() =>
              setSettings({
                ...settings,
                independent: [
                  ...settings.independent,
                  { provider: 'simulado', model: `simulado-v${settings.independent.length + 2}` },
                ],
              })
            }
          >
            Añadir evaluador
          </button>
        </div>

        <p className="small muted" style={{ marginBottom: 12 }}>
          Se recomiendan al menos dos evaluadores distintos para poder comparar. Cada uno evalúa sin
          ver la propuesta primaria.
        </p>

        <div className="stack">
          {settings.independent.map((config, index) => (
            <div className="row" key={index} style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ minWidth: 190 }}>
                Proveedor {index + 1}
                {providerSelect(config.provider, (id) =>
                  updateIndependent(index, { provider: id, model: defaultModel(id) }),
                )}
              </label>
              <label className="field" style={{ flex: 1, minWidth: 170 }}>
                Modelo
                <input
                  value={config.model}
                  onChange={(event) => updateIndependent(index, { model: event.target.value })}
                />
              </label>
              <button className="btn" onClick={() => void test(config, `ind-${index}`)}>
                Probar
              </button>
              <button
                className="btn danger"
                onClick={() =>
                  setSettings({
                    ...settings,
                    independent: settings.independent.filter((_, position) => position !== index),
                  })
                }
              >
                Quitar
              </button>
              {tests[`ind-${index}`] && (
                <span className="small muted" style={{ flexBasis: '100%' }}>
                  {tests[`ind-${index}`]}
                </span>
              )}
            </div>
          ))}
          {settings.independent.length === 0 && (
            <div className="empty">Sin evaluadores independientes: no habrá comparación.</div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Parámetros del lote</h2>
          <span className="badge">máx. {maxBatch} entregas por lote</span>
        </div>
        <div className="grid three">
          <label className="field">
            Umbral de divergencia (puntos)
            <input
              type="number"
              min={0.1}
              max={20}
              step={0.1}
              value={settings.divergenceThreshold}
              onChange={(event) =>
                setSettings({ ...settings, divergenceThreshold: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            Entregas simultáneas
            <input
              type="number"
              min={1}
              max={6}
              value={settings.concurrency}
              onChange={(event) =>
                setSettings({ ...settings, concurrency: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            Máx. páginas por documento enviadas a cada modelo
            <input
              type="number"
              min={1}
              max={20}
              value={settings.maxPagesPerEvaluation}
              onChange={(event) =>
                setSettings({ ...settings, maxPagesPerEvaluation: Number(event.target.value) })
              }
            />
          </label>
          <label className="checkline" style={{ gridColumn: 'span 3' }}>
            <input
              type="checkbox"
              checked={settings.includeImages}
              onChange={(event) => setSettings({ ...settings, includeImages: event.target.checked })}
            />
            <span>
              Enviar las imágenes del examen a los modelos. Desactívalo para ahorrar cuota (la
              calidad de lectura empeora mucho).
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Privacidad y límites</h2>
        <ul className="small muted" style={{ margin: '10px 0 0 18px', padding: 0 }}>
          <li>La app corre en tu equipo; la base de datos y los exámenes viven en <span className="mono">./data</span>.</li>
          <li>
            Los prompts usan seudónimos (Alumno A, B…) y no incluyen nombres ni correos de alumnos.
          </li>
          <li>
            Las imágenes del examen sí se envían a los proveedores en la nube que configures. Usa el
            proveedor simulado si no quieres que salgan del equipo.
          </li>
          <li>La aprobación final siempre es humana: ningún modelo aprueba por sí solo.</li>
        </ul>
      </section>

      {notice && <div className="toast">{notice}</div>}
    </>
  );
}
