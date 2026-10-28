import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import ClassesPage from './pages/ClassesPage';
import ActivitiesPage from './pages/ActivitiesPage';
import ActivityPage from './pages/ActivityPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import { errorMessage, getAuthStatus, logout, type AuthStatus } from './api';

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  async function refreshAuth() {
    try {
      setAuth(await getAuthStatus());
      setAuthError('');
    } catch (error) {
      setAuthError(errorMessage(error));
    }
  }

  useEffect(() => {
    void refreshAuth();
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      setAuth({ required: true, authenticated: false, user: null });
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  if (!auth) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <p className="muted">Comprobando acceso…</p>
          {authError && <p className="alert danger small">{authError}</p>}
        </div>
      </div>
    );
  }

  if (auth.required && !auth.authenticated) {
    return <LoginPage onSuccess={() => void refreshAuth()} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">EC</span>
          <div>
            <strong>Exámenes</strong>
            <small>Biología · Bioquímica</small>
          </div>
        </div>
        <nav>
          <NavLink to="/classes">Clases y alumnos</NavLink>
          <NavLink to="/activities">Actividades</NavLink>
          <NavLink to="/settings">Ajustes y LLM</NavLink>
        </nav>
        <div className="sidebar-foot">
          <p>Uso local y privado.</p>
          <p>Los datos de alumnos no salen de tu equipo salvo las imágenes que se envían a los proveedores LLM que configures.</p>
          {auth.required && auth.user && (
            <p className="sidebar-user">
              Sesión: <strong>{auth.user}</strong>
            </p>
          )}
          {auth.required && (
            <button className="btn ghost small sidebar-logout" onClick={() => void signOut()} disabled={signingOut}>
              {signingOut ? 'Cerrando…' : 'Cerrar sesión'}
            </button>
          )}
          {authError && <p className="small">{authError}</p>}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/activities" replace />} />
          <Route path="/classes" element={<ClassesPage />} />
          <Route path="/activities" element={<ActivitiesPage />} />
          <Route path="/activities/:id" element={<ActivityPage />} />
          <Route path="/submissions/:id" element={<ReviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/activities" replace />} />
        </Routes>
      </main>
    </div>
  );
}
