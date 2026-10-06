// Genera los logos de la PWA a partir de los PNG de diseño. Uso: node scripts/build-logos.mjs "<carpeta PNG>"
import path from 'node:path';
import sharp from 'sharp';

const dir = process.argv[2];
if (!dir) throw new Error('Pasá la carpeta de los PNG de diseño');
const out = (f) => path.join(process.cwd(), 'public', f);

// Encabezado: wordmark gris recortado (sin márgenes) a 600 px de ancho
await sharp(path.join(dir, 'altorancho. gris-01.png'))
  .trim({ threshold: 10 }) // fondo transparente: recorta según el píxel de la esquina
  .resize({ width: 600 })
  .png()
  .toFile(out('logo-wordmark.png'));

// Ícono: "alto." blanco centrado sobre #353434
const size = 1024;
const mark = await sharp(path.join(dir, 'alto. blanco_Mesa de trabajo 1.png'))
  .trim({ threshold: 10 })
  .resize({ width: Math.round(size * 0.7) })
  .png()
  .toBuffer();
const { height } = await sharp(mark).metadata();
await sharp({ create: { width: size, height: size, channels: 4, background: '#353434' } })
  .composite([{ input: mark, left: Math.round(size * 0.15), top: Math.round((size - height) / 2) }])
  .png()
  .toFile(out('logo.png'));
console.log('logos generados en public/');
