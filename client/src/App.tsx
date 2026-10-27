import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import ClassesPage from './pages/ClassesPage';
import ActivitiesPage from './pages/ActivitiesPage';
import ActivityPage from './pages/ActivityPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
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
