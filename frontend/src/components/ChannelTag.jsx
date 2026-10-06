export const CHANNELS = {
  meta: { label: 'Meta', color: '#1877F2' },
  google: { label: 'Google', color: '#F29900' },
  organic: { label: 'Orgánica', color: '#1E9E5A' },
  email: { label: 'Email', color: '#7B5CD6' },
  social_organic: { label: 'Redes', color: '#D6457A' },
  other: { label: 'Otros', color: '#8A8A8A' },
  unknown: { label: 'Sin datos', color: '#8A8A8A' },
};

export default function ChannelTag({ channel }) {
  const c = CHANNELS[channel] || CHANNELS.unknown;
  return <span className="tag" style={{ '--tag': c.color }}>{c.label}</span>;
}
