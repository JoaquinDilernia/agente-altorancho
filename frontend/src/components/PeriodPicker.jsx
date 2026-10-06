import { PRESETS, presetRange } from '../lib/period.js';

export default function PeriodPicker({ period, onChange }) {
  return (
    <div className="period">
      <div className="chips" role="tablist" aria-label="Período">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={period.preset === p.id}
            className={period.preset === p.id ? 'chip active' : 'chip'}
            onClick={() => onChange(p.id === 'custom' ? { ...period, preset: 'custom' } : { preset: p.id, ...presetRange(p.id) })}
          >
            {p.label}
          </button>
        ))}
      </div>
      {period.preset === 'custom' && (
        <div className="custom-range">
          <label>Desde <input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && onChange({ ...period, from: e.target.value })} /></label>
          <label>Hasta <input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && onChange({ ...period, to: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}
