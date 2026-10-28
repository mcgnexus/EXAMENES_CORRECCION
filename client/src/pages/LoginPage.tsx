import { useState, type FormEvent } from 'react';
import { errorMessage, login } from '../api';

interface LoginPageProps {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">EC</span>
          <div>
            <strong>Exámenes</strong>
            <small>Biología · Bioquímica</small>
          </div>
        </div>

        <div>
          <h1>Acceso al panel</h1>
          <p className="muted small">
            Introduce las credenciales del profesor para consultar y corregir exámenes.
          </p>
        </div>

        <label className="field">
          Usuario
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>

        <label className="field">
          Contraseña
          <span className="password-field">
            <input
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              aria-pressed={visible}
              title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8M9.9 5.1A10.5 10.5 0 0121 12a11.8 11.8 0 01-3 3.4M6.2 6.3A11.6 11.6 0 003 12a10.5 10.5 0 0011.1 6.9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              )}
            </button>
          </span>
        </label>

        {error && <p className="alert danger small">{error}</p>}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'Comprobando…' : 'Entrar'}
        </button>

        <p className="small muted login-note">
          La sesión dura 7 días en este navegador. Puedes cerrarla desde el panel.
        </p>
      </form>
    </div>
  );
}
