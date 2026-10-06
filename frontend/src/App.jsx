import { useState, useMemo, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { createApi } from './api.js';
import { loadPeriod, savePeriod, resolvePeriod, artToday } from './lib/period.js';
import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Ventas from './pages/Ventas.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Anuncios from './pages/Anuncios.jsx';
import AdDetail from './pages/AdDetail.jsx';
import Estado from './pages/Estado.jsx';

const API_URL = import.meta.env.VITE_API_URL || '/api';
const PW_KEY = 'ar_pw';

export default function App() {
  const [password, setPassword] = useState(() => localStorage.getItem(PW_KEY) || '');
  const [period, setPeriodState] = useState(() => loadPeriod());
  const setPeriod = useCallback((p) => { savePeriod(p); setPeriodState(p); }, []);
  // La PWA puede quedar abierta de un día para otro: al volver a primer plano se recalcula "Hoy"
  const [today, setToday] = useState(() => artToday());
  useEffect(() => {
    const refresh = () => setToday(artToday());
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const effectivePeriod = useMemo(() => resolvePeriod(period), [period, today]);

  const logout = useCallback(() => {
    localStorage.removeItem(PW_KEY);
    setPassword('');
  }, []);

  const api = useMemo(() => (password
    ? createApi({ baseUrl: API_URL, getToken: async () => password, onAuthError: logout })
    : null), [password, logout]);

  if (!api) {
    return <Login apiUrl={API_URL} onLogin={(pw) => { localStorage.setItem(PW_KEY, pw); setPassword(pw); }} />;
  }

  const props = { api, period: effectivePeriod, setPeriod };
  return (
    <Layout api={api} onLogout={logout}>
      <Routes>
        <Route path="/" element={<Ventas {...props} />} />
        <Route path="/orden/:id" element={<OrderDetail {...props} />} />
        <Route path="/anuncios" element={<Anuncios {...props} />} />
        <Route path="/anuncios/:id" element={<AdDetail {...props} />} />
        <Route path="/estado" element={<Estado {...props} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
