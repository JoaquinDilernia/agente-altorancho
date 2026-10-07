import { CHANNELS } from './ChannelTag.jsx';

// Íconos simples por canal (SVG inline, sin dependencias): hoja = orgánica, logo de Meta, "G" de Google, etc.
const PATHS = {
  organic: (
    <path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Zm0 0 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ),
  meta: (
    <path d="M3 15c0-4 2-8 5-8 4 0 6 10 9 10 2 0 4-2 4-6s-2-6-4-6c-3 0-5 4-7 7-2 3-3 5-5 5s-2-1-2-2Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  ),
  google: (
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 12h-8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  ),
  email: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </>
  ),
  social_organic: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="7" r="1.2" fill="currentColor" />
    </>
  ),
  other: <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />,
  unknown: (
    <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
};

export default function ChannelIcon({ channel, size = 22, label, className = 'channel-icon' }) {
  const c = CHANNELS[channel] || CHANNELS.unknown;
  const text = label || c.label;
  return (
    <span className={className} style={{ '--tag': c.color }} role="img" aria-label={text} title={text}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{PATHS[channel] || PATHS.unknown}</svg>
    </span>
  );
}

// Fila con todos los canales: encendidos los que participaron de la compra (canal de compra y, con GA4,
// el canal por el que conoció la tienda), apagados el resto.
const TRAIL = ['meta', 'google', 'email', 'social_organic', 'organic'];

export function ChannelTrail({ active = [] }) {
  const on = new Set(active.filter(Boolean));
  return (
    <span className="channel-trail">
      {TRAIL.map((ch) => {
        const lit = on.has(ch);
        const name = (CHANNELS[ch] || CHANNELS.unknown).label;
        return (
          <ChannelIcon key={ch} channel={ch} size={14} className={lit ? 'trail-icon lit' : 'trail-icon'}
            label={`${name}: ${lit ? 'participó' : 'no participó'}`} />
        );
      })}
    </span>
  );
}
