// Build-time refresh of David's Goodreads "read" shelf.
//
// Runs as the first step of `npm run build` (see package.json), so every build -
// including the scheduled fortnightly rebuild on Cloudflare Pages - pulls the latest
// shelf + covers. RESILIENT BY DESIGN: any failure (Goodreads down, feed empty,
// network error) logs a warning and exits 0 WITHOUT touching the committed data, so
// the build always succeeds using the last-known books. Covers are downloaded
// incrementally (existing files reused; only new ones fetched) and orphans pruned.
//
// The reading window (last ~5 years) is applied later, at render time, in
// src/components/BookGrid.astro - this script just writes the full shelf.

import sharp from 'sharp';
import { readdirSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const USER = '203579059';
const OUT_IMG = 'public/books';
const OUT_DATA = 'src/data';
const DATA_FILE = join(OUT_DATA, 'books.json');
const H = { 'User-Agent': 'Mozilla/5.0 (personal-site build)', 'Cache-Control': 'no-cache' };
const FEED = (page) =>
  `https://www.goodreads.com/review/list_rss/${USER}?shelf=read&per_page=100&page=${page}&_=${Date.now()}`;

const unwrap = (s) => {
  if (!s) return '';
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
};
const field = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? unwrap(m[1]) : '';
};

async function fetchAllItems() {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(FEED(page), { headers: H, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`RSS page ${page} -> HTTP ${res.status}`);
    const xml = await res.text();
    const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    if (blocks.length === 0) break;
    for (const b of blocks) {
      items.push({
        id: field(b, 'book_id'),
        title: field(b, 'title'),
        author: field(b, 'author_name'),
        rating: Number(field(b, 'user_rating') || '0'),
        readAt: field(b, 'user_read_at'),
        cover:
          field(b, 'book_large_image_url') ||
          field(b, 'book_image_url') ||
          field(b, 'book_medium_image_url'),
      });
    }
    if (blocks.length < 100) break;
  }
  return items;
}

try {
  const items = await fetchAllItems();
  if (!items.length) throw new Error('feed returned 0 items');

  const readTime = (s) => (s ? new Date(s).getTime() : 0);
  items.sort((a, b) => readTime(b.readAt) - readTime(a.readAt));

  mkdirSync(OUT_IMG, { recursive: true });
  mkdirSync(OUT_DATA, { recursive: true });

  const keep = new Set();
  const books = [];
  let downloaded = 0;
  for (const it of items) {
    const ym = (it.readAt || '').match(/\b(19|20)\d{2}\b/);
    const year = ym ? Number(ym[0]) : null;
    const file = `${it.id}.jpg`;
    const outPath = join(OUT_IMG, file);
    let coverPath = null;
    const isPlaceholder = !it.cover || /nophoto|no-cover/i.test(it.cover);
    if (!isPlaceholder) {
      if (existsSync(outPath)) {
        coverPath = `/books/${file}`; // reuse already-downloaded cover
      } else {
        try {
          const r = await fetch(it.cover, { headers: H, signal: AbortSignal.timeout(20000) });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            await sharp(buf).resize({ width: 300, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(outPath);
            coverPath = `/books/${file}`;
            downloaded++;
          }
        } catch (e) {
          console.warn(`  cover skip: ${it.title} (${e.message})`);
        }
      }
    }
    if (coverPath) keep.add(file);
    books.push({
      id: it.id,
      title: it.title,
      author: it.author,
      rating: it.rating,
      readAt: it.readAt || null,
      year,
      cover: coverPath,
      url: `https://www.goodreads.com/book/show/${it.id}`,
    });
  }

  // Prune covers no longer referenced (only on a successful full fetch).
  for (const f of readdirSync(OUT_IMG)) {
    if (f.endsWith('.jpg') && !keep.has(f)) rmSync(join(OUT_IMG, f));
  }

  writeFileSync(DATA_FILE, JSON.stringify(books, null, 2));
  console.log(`Goodreads: ${books.length} books (${downloaded} new covers).`);
} catch (e) {
  const have = existsSync(DATA_FILE);
  console.warn(`Goodreads refresh skipped: ${e.message}. ${have ? 'Using committed books.json.' : 'No committed data - grid may be empty.'}`);
  process.exit(0); // never fail the build
}
