import { NavLink } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling.js';
import { fmtRelative } from '../lib/format.js';

const NAV = [
  { to: '/', label: 'Ventas', icon: '◫' },
  { to: '/anuncios', label: 'Anuncios', icon: '◎' },
  { to: '/estado', label: 'Estado', icon: '↻' },
  { to: '/agente', label: 'Agente', icon: '✦' },
];
const STALE_MS = 2 * 3600 * 1000;
const KEY_SOURCES = ['tn_incremental', 'meta_spend'];

function syncInfo(status) {
  if (!status) return null;
  const times = KEY_SOURCES.map((s) => status.lastSuccess.find((r) => r.source === s)?.finished_at).filter(Boolean);
  if (times.length === 0) return { text: 'Sin sincronizar todavía', stale: true };
  const oldest = times.sort()[0];
  const failed = status.runs.some((r) => KEY_SOURCES.includes(r.source) && r.status === 'error');
  const stale = failed || times.length < KEY_SOURCES.length || Date.now() - new Date(oldest).getTime() > STALE_MS;
  return { text: stale ? `Datos desactualizados · ${fmtRelative(oldest)}` : `Actualizado ${fmtRelative(oldest)}`, stale };
}

export default function Layout({ api, onLogout, children }) {
  const { data } = usePolling(() => api.get('/status'), [api], 5 * 60_000);
  const info = syncInfo(data);
  const { data: agent } = usePolling(() => api.get('/agent/overview'), [api], 5 * 60_000);
  const pending = agent?.pendingCount || 0;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><img src="/logo-wordmark.png" alt="altorancho." className="brand-logo" /> <span>Ventas</span></div>
        <button className="link-btn" onClick={onLogout}>Salir</button>
      </header>
      {info && <div className={info.stale ? 'sync-line stale' : 'sync-line'}>{info.text}</div>}
      <main className="content">{children}</main>
      <nav className="bottom-nav">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
            {item.to === '/agente' && pending > 0 && <span className="nav-badge" aria-label={`${pending} pendientes`}>{pending}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
