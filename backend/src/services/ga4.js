import crypto from 'node:crypto';

// Cliente mínimo de la Google Analytics Data API con cuenta de servicio (JWT firmado, sin dependencias).
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export function createGa4Client({ serviceAccountJson, propertyId, fetchFn = fetch, pageSize = 100000, now = () => Date.now() }) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  let cached = null;

  async function token() {
    if (cached && cached.expires > now() + 60_000) return cached.value;
    const iat = Math.floor(now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!res.ok) throw new Error(`GA4 token ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    cached = { value: json.access_token, expires: now() + json.expires_in * 1000 };
    return cached.value;
  }

  async function runReport(body) {
    const res = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  return {
    runReport,
    // Pagina con offset/limit hasta traer todas las filas
    async runReportAll(body) {
      const rows = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await runReport({ ...body, offset, limit: pageSize });
        rows.push(...(page.rows || []));
        if (!page.rows || page.rows.length < pageSize || rows.length >= (page.rowCount || 0)) return rows;
      }
    },
  };
}
