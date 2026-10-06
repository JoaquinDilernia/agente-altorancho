import { defineConfig } from '@vite-pwa/assets-generator/config';

// El logo ya trae su fondo #353434: sin padding y con el mismo fondo en maskable/apple
export default defineConfig({
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']], padding: 0 },
    maskable: { sizes: [512], padding: 0.1, resizeOptions: { background: '#353434' } },
    apple: { sizes: [180], padding: 0.1, resizeOptions: { background: '#353434' } },
  },
  images: ['public/logo.png'],
});
