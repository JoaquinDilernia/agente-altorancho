import { useState, useMemo, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { createApi } from './api.js';
import { loadPeriod, savePeriod } from './lib/period.js';
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

  const props = { api, period, setPeriod };
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
