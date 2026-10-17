import { useEffect, useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import { fmtNumber } from '../../lib/format.js';
import { AdsetSelect, useAction } from './shared.jsx';

const MEDIA_ACCEPT = 'image/jpeg,image/png,video/mp4,video/quicktime';
const mediaKind = (file) => (file?.type?.startsWith('video/') ? 'video' : 'image');
const TYPE_LABEL = { reel: 'Reel', carousel: 'Carrusel', post: 'Post' };
const day = (iso) => new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });

function checkFile(file) {
  if (!file) return null;
  if (!MEDIA_ACCEPT.split(',').includes(file.type)) return 'Elegí una imagen JPG/PNG o un video MP4/MOV.';
  if (mediaKind(file) === 'image' && file.size > 8 * 1024 * 1024) return 'La imagen pesa más de 8 MB.';
  if (mediaKind(file) === 'video' && file.size > 200 * 1024 * 1024) return 'El video pesa más de 200 MB.';
  return null;
}

function MediaPreview({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!file || !url) return null;
  return mediaKind(file) === 'video'
    ? <video src={url} className="preview" muted playsInline controls />
    : <img src={url} alt="" className="preview" />;
}

function PieceMedia({ media }) {
  if (!media) return <div className="piece-img empty">Sin imagen</div>;
  const src = media.kind === 'video' ? media.thumbnail_url : media.image_url;
  return (
    <div className="piece-img">
      {src ? <img src={src} alt="" /> : <span>Video procesándose en Meta</span>}
      {media.kind === 'video' && <span className="piece-play" aria-label="Video">▶</span>}
    </div>
  );
}

export default function Piezas({ api, snapshot, storeUrl }) {
  const creatives = usePolling(() => api.get('/ads/creatives').then((r) => r.creatives), [api], 120_000);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(null);
  const { busy, error, run } = useAction(() => creatives.reload());
  const list = (creatives.data || []).filter((c) => c.status !== 'archived');
  const adsets = snapshot?.adsets || [];

  return (
    <>
      {!creating && <button type="button" className="btn" onClick={() => setCreating(true)}>Nueva pieza</button>}
      {creating && <NewPiece api={api} storeUrl={storeUrl} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); creatives.reload(); }} />}
      {error && <p className="error">{error}</p>}
      {creatives.data && list.length === 0 && !creating && (
        <p className="muted" style={{ marginTop: 12 }}>Todavía no hay piezas. Subí la imagen o el video (feed 4:5 y, si hay, historia 9:16) con el texto del anuncio. Después la publicás en un conjunto o se la dejás al agente.</p>
      )}
      <div className="pieces">
        {list.map((c) => (
          <article key={c.id} className="piece">
            <PieceMedia media={c.feed} />
            <div className="piece-body">
              <div className="row-sub" style={{ marginTop: 0 }}>
                <strong style={{ color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</strong>
                <span className={c.status === 'used' ? 'badge ok' : 'badge'}>{c.status === 'used' ? 'Publicada' : c.status === 'publishing' ? 'Publicando…' : 'Sin usar'}</span>
              </div>
              <p className="piece-copy">{c.copy}</p>
              <a className="note" href={c.link} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{c.link}</a>
              {c.story && <p className="note">Con versión historia 9:16 ({c.story.kind === 'video' ? 'video' : 'imagen'})</p>}
              {c.status === 'unused' && (
                publishing === c.id
                  ? <Publish api={api} creative={c} adsets={adsets} onClose={() => setPublishing(null)} onDone={() => { setPublishing(null); creatives.reload(); }} />
                  : (
                    <div className="actions">
                      <button type="button" className="btn" disabled={!snapshot || !c.feed || !!busy} onClick={() => setPublishing(c.id)}>Publicar</button>
                      <button type="button" className="chip" disabled={!!busy} onClick={() => run(c.id, () => api.patch(`/ads/creatives/${c.id}`, { status: 'archived' }))}>Archivar</button>
                    </div>
                  )
              )}
            </div>
          </article>
        ))}
      </div>
      <IgPosts api={api} adsets={adsets} storeUrl={storeUrl} />
    </>
  );
}

function NewPiece({ api, storeUrl, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', copy: '', headline: '', link: '', notes: '' });
  const [feed, setFeed] = useState(null);
  const [story, setStory] = useState(null);
  const [progress, setProgress] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const fileError = checkFile(feed) || checkFile(story);
  const ok = form.name.trim() && form.copy.trim() && feed && !fileError && !saving;

  async function submit() {
    setSaving(true);
    setError(null);
    let creative = null;
    try {
      creative = (await api.post('/ads/creatives', form)).creative;
      await api.upload(`/ads/creatives/${creative.id}/media/feed`, feed, (p) => setProgress({ slot: 'feed', p }));
      if (story) await api.upload(`/ads/creatives/${creative.id}/media/story`, story, (p) => setProgress({ slot: 'story', p }));
      onSaved();
    } catch (e) {
      // Una pieza a medio subir no le sirve al agente: se archiva
      if (creative) await api.patch(`/ads/creatives/${creative.id}`, { status: 'archived' }).catch(() => {});
      setError(e.message);
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  return (
    <section className="panel form">
      <label className="field">Nombre *<input className="input" maxLength={60} value={form.name} onChange={set('name')} placeholder="Corto, para reconocerla (ej. Lámpara Nórdica living)" /></label>
      <label className="field">Feed 4:5 (1080×1350) *
        <input type="file" accept={MEDIA_ACCEPT} onChange={(e) => setFeed(e.target.files[0] ?? null)} />
        <span className="note">Imagen JPG/PNG hasta 8 MB o video MP4/MOV hasta 200 MB.</span>
      </label>
      <MediaPreview file={feed} />
      <label className="field">Historia 9:16 (1080×1920)
        <input type="file" accept={MEDIA_ACCEPT} onChange={(e) => setStory(e.target.files[0] ?? null)} />
        <span className="note">Opcional. Si no la subís, Meta adapta la de feed.</span>
      </label>
      <MediaPreview file={story} />
      {fileError && <p className="error">{fileError}</p>}
      <label className="field">Texto del anuncio *<textarea className="input" rows={4} maxLength={2000} value={form.copy} onChange={set('copy')} /></label>
      <label className="field">Título<input className="input" maxLength={80} value={form.headline} onChange={set('headline')} placeholder="Opcional, una línea corta" /></label>
      <label className="field">Link de la tienda
        <input className="input" type="url" maxLength={1000} value={form.link} onChange={set('link')} placeholder={storeUrl} />
        <span className="note">Producto o categoría a la que lleva el botón “Comprar”. Vacío = la home.</span>
      </label>
      <label className="field">Notas para el agente<textarea className="input" rows={2} maxLength={2000} value={form.notes} onChange={set('notes')} placeholder="Opcional: a qué público apunta, qué ángulo prueba" /></label>
      {progress && (
        <div className="field">
          <span className="note">Subiendo {progress.slot === 'feed' ? 'feed' : 'historia'} a Meta: {Math.round(progress.p * 100)}%{progress.p >= 1 ? ' — procesando…' : ''}</span>
          <div className="bar"><span style={{ width: `${Math.round(progress.p * 100)}%`, '--tag': 'var(--text)' }} /></div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={!ok} onClick={submit}>{saving ? 'Guardando…' : 'Guardar pieza'}</button>
        <button type="button" className="btn secondary" disabled={saving} onClick={onClose}>Cancelar</button>
      </div>
    </section>
  );
}

function Publish({ api, creative, adsets, onClose, onDone }) {
  const [adsetId, setAdsetId] = useState(adsets[0]?.id ?? '');
  const { busy, error, run } = useAction(onDone);
  const adset = adsets.find((a) => a.id === adsetId);
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <AdsetSelect adsets={adsets} value={adsetId} onChange={setAdsetId} />
      <span className="note">El anuncio queda activo dentro del conjunto: si el conjunto o la campaña están pausados, no gasta hasta que los actives.</span>
      {error && <p className="error">{error}</p>}
      <div className="actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn" disabled={!adsetId || !!busy}
          onClick={() => run('pub', () => api.post(`/ads/creatives/${creative.id}/publish`, { adset_id: adsetId, adset_name: adset?.name ?? '' }))}>
          {busy ? 'Publicando…' : 'Publicar en Meta'}
        </button>
        <button type="button" className="btn secondary" disabled={!!busy} onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

// Posts y reels ya publicados en el Instagram de Altorancho, para promocionarlos como anuncio
function IgPosts({ api, adsets, storeUrl }) {
  const posts = usePolling(() => api.get('/ads/ig-posts').then((r) => r.posts), [api], 600_000);
  const [promoting, setPromoting] = useState(null);
  return (
    <section>
      <h2 className="section-title">Posts de Instagram</h2>
      {posts.error && <p className="error">{posts.error}</p>}
      {posts.data?.length === 0 && <p className="muted">No hay posts en la cuenta.</p>}
      <div className="pieces">
        {(posts.data || []).map((p) => (
          <article key={p.id} className="piece">
            <div className="piece-img">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <span>Sin vista previa</span>}</div>
            <div className="piece-body">
              <div className="row-sub" style={{ marginTop: 0 }}><span className="badge">{TYPE_LABEL[p.type]}</span><span>{day(p.timestamp)}</span></div>
              <p className="piece-copy">{p.caption}</p>
              <p className="note">{fmtNumber(p.likes)} me gusta · {fmtNumber(p.comments)} comentarios{p.reach != null ? ` · ${fmtNumber(p.reach)} de alcance` : ''}</p>
              {p.promotedIn.map((x) => <span key={x.adset_id} className="badge ok" style={{ marginTop: 4 }}>Promocionado en {x.adset_name || x.adset_id}</span>)}
              {promoting === p.id
                ? <Promote api={api} post={p} adsets={adsets} storeUrl={storeUrl} onClose={() => setPromoting(null)} onDone={() => { setPromoting(null); posts.reload(); }} />
                : (
                  <div className="actions">
                    <button type="button" className="btn" disabled={adsets.length === 0} onClick={() => setPromoting(p.id)}>Promocionar</button>
                    <a className="chip" href={p.permalink} target="_blank" rel="noreferrer">Ver en Instagram</a>
                  </div>
                )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Promote({ api, post, adsets, storeUrl, onClose, onDone }) {
  const already = new Set(post.promotedIn.map((x) => x.adset_id));
  const options = adsets.filter((a) => !already.has(a.id));
  const [adsetId, setAdsetId] = useState(options[0]?.id ?? '');
  const [link, setLink] = useState('');
  const { busy, error, run } = useAction(onDone);
  const adset = options.find((a) => a.id === adsetId);
  if (options.length === 0) return <p className="note">Ya está promocionado en todos los conjuntos.</p>;
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <AdsetSelect adsets={options} value={adsetId} onChange={setAdsetId} />
      <input className="input" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder={`Link del producto (vacío = ${storeUrl})`} aria-label="Link de la tienda" />
      <span className="note">Se usa el post original con botón “Comprar”. El anuncio queda activo dentro del conjunto.</span>
      {error && <p className="error">{error}</p>}
      <div className="actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn" disabled={!adsetId || !!busy}
          onClick={() => run('promote', () => api.post(`/ads/ig-posts/${post.id}/promote`, { adset_id: adsetId, adset_name: adset?.name ?? '', permalink: post.permalink, link: link.trim() }))}>
          {busy ? 'Promocionando…' : 'Promocionar en Meta'}
        </button>
        <button type="button" className="btn secondary" disabled={!!busy} onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}
