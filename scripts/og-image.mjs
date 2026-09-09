// Generates the Open Graph / Twitter share card -> public/og-image.jpg (1200x630).
//
// This is a one-off asset generator, run on demand (npm run og), NOT at build
// time - the result is committed as a static file so the deploy build stays
// simple and font-independent.
//
// Source portrait: prefers public/og-source.jpg (David's LinkedIn blazer photo);
// falls back to public/home-portrait.jpg so there is always a valid card.
// To swap the photo: drop a portrait at public/og-source.jpg and run `npm run og`.

import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pub = join(root, 'public');

// --- Brand tokens (dark card = strongest on light + dark feeds) ---
const BG = '#2c2e31'; // charcoal
const FG = '#eef0f2'; // near-white
const MUTED = '#b7bcc2'; // muted text
const GOLD = '#e3b34e'; // luminous gold (dark-mode accent)

const W = 1200;
const H = 630;
const PHOTO_W = 470; // right-hand portrait panel width

// --- Pick the source portrait ---
const candidates = ['og-source.jpg', 'og-source.png', 'og-source.jpeg', 'home-portrait.jpg'];
const srcName = candidates.find((f) => existsSync(join(pub, f)));
if (!srcName) {
  console.error('No source portrait found in public/ (looked for og-source.* or home-portrait.jpg).');
  process.exit(1);
}
const srcPath = join(pub, srcName);
console.log(`OG card: using portrait ${srcName}`);

// --- Embed Figtree so text matches the site regardless of system fonts ---
const fontB64 = readFileSync(join(__dirname, 'og-assets', 'Figtree-Variable.ttf')).toString('base64');

// Portrait, cover-cropped to the right panel.
const photo = await sharp(srcPath)
  .resize(PHOTO_W, H, { fit: 'cover', position: 'attention' })
  .toBuffer();

// A soft charcoal scrim on the photo's left edge so it blends into the panel.
const scrim = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${H}">
     <defs>
       <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
         <stop offset="0" stop-color="${BG}" stop-opacity="0.95"/>
         <stop offset="0.28" stop-color="${BG}" stop-opacity="0"/>
       </linearGradient>
     </defs>
     <rect width="${PHOTO_W}" height="${H}" fill="url(#g)"/>
   </svg>`
);

// Text overlay (left panel + gold divider).
const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <style>
    @font-face {
      font-family: 'Figtree';
      src: url('data:font/ttf;base64,${fontB64}') format('truetype');
      font-weight: 300 800;
    }
    .name { font-family: 'Figtree', sans-serif; font-weight: 800; fill: ${FG}; }
    .role { font-family: 'Figtree', sans-serif; font-weight: 500; fill: ${MUTED}; }
    .url  { font-family: 'Figtree', sans-serif; font-weight: 700; fill: ${GOLD}; letter-spacing: 0.5px; }
  </style>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <!-- gold divider between text and photo -->
  <rect x="${W - PHOTO_W - 5}" y="0" width="5" height="${H}" fill="${GOLD}"/>
  <text x="80" y="300" class="name" font-size="86">David Goodloe</text>
  <text x="82" y="352" class="role" font-size="30" xml:space="preserve">Director | BranchRegenerate<tspan font-size="18" dy="-14">TM</tspan><tspan dy="14">  Business Unit</tspan></text>
  <text x="82" y="200" class="url" font-size="26">davidgoodloe.ai</text>
</svg>`;

await sharp({ create: { width: W, height: H, channels: 3, background: BG } })
  .composite([
    { input: Buffer.from(textSvg), top: 0, left: 0 },
    { input: photo, top: 0, left: W - PHOTO_W },
    { input: scrim, top: 0, left: W - PHOTO_W },
  ])
  .jpeg({ quality: 88, mozjpeg: true })
  .toFile(join(pub, 'og-image.jpg'));

console.log('Wrote public/og-image.jpg (1200x630)');
