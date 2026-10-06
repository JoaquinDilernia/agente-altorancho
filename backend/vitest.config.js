import { defineConfig } from 'vitest/config';

// PGlite (Postgres en WASM) tarda varios segundos en arrancar cuando corren muchos archivos en paralelo
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
