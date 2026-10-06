import { useState } from 'react';

export default function Login({ onLogin, apiUrl }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiUrl}/status`, { headers: { Authorization: `Bearer ${pw}` } });
      if (res.status === 401) {
        setError('Contraseña incorrecta');
        return;
      }
      if (!res.ok) throw new Error(`Error ${res.status}`);
      onLogin(pw);
    } catch {
      setError('No se pudo conectar con el servidor');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">ALTORANCHO <span>Ventas</span></div>
        <input type="password" placeholder="Contraseña" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={loading || !pw}>{loading ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
