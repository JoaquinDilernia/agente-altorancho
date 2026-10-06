import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createApp } from '../src/app.js';

describe('app', () => {
  it('responde /health', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it('/health mezcla datos de health() y devuelve 503 si falla', async () => {
    expect((await request(createApp({ health: async () => ({ db: true }) })).get('/health')).body).toEqual({ ok: true, db: true });
    const res = await request(createApp({ health: async () => { throw new Error('db caída'); } })).get('/health');
    expect(res.status).toBe(503);
  });
  it('permite CORS solo desde el dominio del frontend', async () => {
    const app = createApp({ corsOrigin: 'https://agente.techdi.com.ar' });
    const ok = await request(app).get('/health').set('Origin', 'https://agente.techdi.com.ar');
    expect(ok.headers['access-control-allow-origin']).toBe('https://agente.techdi.com.ar');
    const other = await request(app).get('/health').set('Origin', 'https://otro.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('sirve el frontend y hace fallback SPA, sin tapar /api', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    const api = express.Router();
    api.get('/ping', (_req, res) => res.json({ pong: true }));
    const app = createApp({ staticDir: dir, apiRouter: api });
    expect((await request(app).get('/app.js')).text).toBe('console.log(1)');
    const spa = await request(app).get('/anuncios/123');
    expect(spa.text).toBe('<html>app</html>');
    expect(spa.headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/api/ping')).body).toEqual({ pong: true });
    expect((await request(app).get('/api/nada')).status).toBe(404);
  });
});
