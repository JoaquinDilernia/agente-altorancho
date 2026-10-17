import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LogOut, Megaphone, RefreshCw, ShoppingBag, Sparkles } from 'lucide-react';
import { usePolling } from '../hooks/usePolling.js';
import { fmtRelative } from '../lib/format.js';
import PageHeader from './PageHeader.jsx';

const NAV = [
  { to: '/', label: 'Ventas', Icon: ShoppingBag },
  { to: '/anuncios', label: 'Anuncios', Icon: Megaphone },
  { to: '/estado', label: 'Estado', Icon: RefreshCw },
  { to: '/agente', label: 'Agente', Icon: Sparkles },
];
// Títulos de las secciones principales (las de detalle y el agente traen su propio encabezado)
const TITLES = {
  '/': { title: 'Ventas', subtitle: 'Pedidos de la tienda y de dónde vinieron' },
  '/anuncios': { title: 'Anuncios', subtitle: 'Cuánto vende cada anuncio' },
  '/estado': { title: 'Estado', subtitle: 'Sincronizaciones y conexiones' },
};
const STALE_MS = 2 * 3600 * 1000;
const KEY_SOURCES = ['tn_incremental', 'meta_spend'];
const DESKTOP = '(min-width: 900px)';

function syncInfo(status) {
  if (!status) return null;
  const times = KEY_SOURCES.map((s) => status.lastSuccess.find((r) => r.source === s)?.finished_at).filter(Boolean);
  if (times.length === 0) return { text: 'Sin sincronizar todavía', stale: true };
  const oldest = times.sort()[0];
  const failed = status.runs.some((r) => KEY_SOURCES.includes(r.source) && r.status === 'error');
  const stale = failed || times.length < KEY_SOURCES.length || Date.now() - new Date(oldest).getTime() > STALE_MS;
  return { text: stale ? `Datos desactualizados · ${fmtRelative(oldest)}` : `Actualizado ${fmtRelative(oldest)}`, stale };
}

function useIsDesktop() {
  const query = () => typeof window !== 'undefined' && !!window.matchMedia?.(DESKTOP).matches;
  const [desktop, setDesktop] = useState(query);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP);
    if (!mq) return undefined;
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

function NavItems({ pending, className }) {
  return NAV.map(({ to, label, Icon }) => (
    <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `${className}${isActive ? ' active' : ''}`}>
      <span className="nav-icon" aria-hidden="true">
        <Icon size={className === 'side-link' ? 19 : 22} strokeWidth={1.8} />
        {to === '/agente' && pending > 0 && <span className="nav-badge" aria-label={`${pending} pendientes`}>{pending}</span>}
      </span>
      <span className="nav-label">{label}</span>
    </NavLink>
  ));
}

export default function Layout({ api, onLogout, children }) {
  const desktop = useIsDesktop();
  const { pathname } = useLocation();
  const { data } = usePolling(() => api.get('/status'), [api], 5 * 60_000);
  const info = syncInfo(data);
  const { data: agent } = usePolling(() => api.get('/ads/badge'), [api], 5 * 60_000);
  const pending = (agent?.pendingCount || 0) + (agent?.openQuestions || 0);
  const header = TITLES[pathname];
  const sync = info && <div className={info.stale ? 'sync-line stale' : 'sync-line'}>{info.text}</div>;

  return (
    <div className={desktop ? 'shell desktop' : 'shell'}>
      {desktop ? (
        <aside className="sidebar">
          <div className="side-brand"><img src="/logo-wordmark.png" alt="altorancho." className="brand-logo" /></div>
          <nav className="side-nav"><NavItems pending={pending} className="side-link" /></nav>
          <div className="side-foot">
            {sync}
            <button type="button" className="side-link" onClick={onLogout}>
              <span className="nav-icon" aria-hidden="true"><LogOut size={19} strokeWidth={1.8} /></span>
              <span className="nav-label">Salir</span>
            </button>
          </div>
        </aside>
      ) : (
        <>
          <header className="topbar">
            <div className="brand"><img src="/logo-wordmark.png" alt="altorancho." className="brand-logo" /></div>
            <button type="button" className="icon-btn" onClick={onLogout} aria-label="Salir"><LogOut size={18} strokeWidth={1.8} /></button>
          </header>
          {sync}
        </>
      )}
      <main className="content">
        {header && <PageHeader title={header.title} subtitle={header.subtitle} />}
        {children}
      </main>
      {!desktop && <nav className="bottom-nav"><NavItems pending={pending} className="tab-link" /></nav>}
    </div>
  );
}
