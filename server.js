import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveGoogleDrive, resolveByseEmbed, resolveFilemoon } from './resolver.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'crtanko_db.json');

const app = express();
app.use(cors());
app.use(express.json());

function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      console.error('Error reading database:', err.message);
      return {};
    }
  }
  return {};
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────
const manifest = {
  id: 'org.crtanko.addons',
  version: '1.0.0',
  name: 'Crtanko - Sinkronizirani Crtići',
  description: 'Sinkronizirani crtani filmovi i serije na hrvatskom jeziku s crtanko.xyz',
  logo: 'https://www.crtanko.xyz/wp-content/themes/crtanko/favicon.ico',
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      id: 'crtanko_movies',
      type: 'movie',
      name: 'Crtanko Filmovi',
      extra: [{ name: 'search', isRequired: false }]
    },
    {
      id: 'crtanko_series',
      type: 'series',
      name: 'Crtanko Serije',
      extra: [{ name: 'search', isRequired: false }]
    }
  ],
  idPrefixes: ['tt']
};

app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

// ─── CATALOG ─────────────────────────────────────────────────────────────────
app.get('/catalog/:type/:id.json', (req, res) => {
  const { type } = req.params;
  const search = req.query.search || '';
  const db = loadDatabase();

  const metas = Object.values(db)
    .filter(item => item.type === type)
    .filter(item => !search || item.title.toLowerCase().includes(search.toLowerCase()))
    .map(item => ({
      id: item.imdb_id,
      type: item.type,
      name: item.title,
      poster: item.poster,
      genres: item.genres || []
    }));

  res.json({ metas });
});

// ─── STREAM ───────────────────────────────────────────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  console.log(`[Server] Stream requested: type=${type}, id=${id}`);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');

  const db = loadDatabase();
  const streams = [];

  /**
   * Wraps a filmativa embed URL into a URL pointing at our Edge Function proxy.
   * The Edge Function runs on Cloudflare BoringSSL (Chrome TLS fingerprint) so
   * it can bypass the filmativa CDN's TLS fingerprint check that blocks Node.js.
   */
  function filmativaProxyUrl(embedUrl) {
    const enc = Buffer.from(embedUrl).toString('base64url');
    return `${protocol}://${host}/api/hls-filmativa?embed=${enc}`;
  }

  try {
    // ── MOVIE ─────────────────────────────────────────────────────────────────
    if (type === 'movie') {
      const item = db[id];
      if (item && item.apiData) {
        const apiData = item.apiData;

        // SD stream
        if (apiData.videolink) {
          if (apiData.videolink.includes('roda.php')) {
            try {
              const html = await (await fetch(apiData.videolink, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.crtanko.xyz/' }
              })).text();
              const m = html.match(/<source\s+src="([^"]+)"/);
              if (m) streams.push({ name: 'Crtanko SD', url: m[1] });
            } catch (e) { console.error('[Movie] roda.php SD error:', e.message); }
          } else if (apiData.videolink.includes('player.filmativa.club')) {
            // Filmativa: route through Edge Function (Chrome TLS fingerprint)
            console.log(`[Movie] Filmativa SD via Edge proxy: ${apiData.videolink}`);
            streams.push({ name: 'Crtanko SD', url: filmativaProxyUrl(apiData.videolink) });
          }
        }

        // HD stream
        if (apiData.videolinkhd) {
          if (apiData.videolinkhd.includes('player.filmativa.club')) {
            console.log(`[Movie] Filmativa HD via Edge proxy: ${apiData.videolinkhd}`);
            streams.push({ name: 'Crtanko HD', url: filmativaProxyUrl(apiData.videolinkhd) });
          } else if (apiData.videolinkhd.includes('roda.php')) {
            try {
              const html = await (await fetch(apiData.videolinkhd, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.crtanko.xyz/' }
              })).text();
              const m = html.match(/<source\s+src="([^"]+)"/);
              if (m) streams.push({ name: 'Crtanko HD', url: m[1] });
            } catch (e) { console.error('[Movie] roda.php HD error:', e.message); }
          }
        }
      }

    // ── SERIES ────────────────────────────────────────────────────────────────
    } else if (type === 'series') {
      const parts = id.split(':');
      if (parts.length === 3) {
        const imdbId = parts[0];
        const season = parts[1];
        const episode = parts[2];
        const episodeKey = `s${season}_${episode}`;

        const item = db[imdbId];
        if (item && item.streaming && item.streaming[episodeKey]) {
          const epUrl = item.streaming[episodeKey];

          if (epUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)) {
            // Google Drive
            const fileId = epUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)[1];
            console.log(`[Series] GD episode ${episodeKey}: ${fileId}`);
            const directUrl = await resolveGoogleDrive(fileId);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });

          } else if (epUrl.includes('player.filmativa.club')) {
            // Filmativa: route through Edge Function
            console.log(`[Series] Filmativa episode ${episodeKey}: ${epUrl}`);
            streams.push({
              name: `S${season}E${episode} (HD)`,
              url: filmativaProxyUrl(epUrl)
            });

          } else if (epUrl.includes('bysevepoin.com') || epUrl.includes('bysezoxexe.com')) {
            console.log(`[Series] Byse episode ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveByseEmbed(epUrl);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });

          } else if (epUrl.includes('filemoon')) {
            console.log(`[Series] Filemoon episode ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveFilemoon(epUrl);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });
          }
        }

        // Download link as fallback for filmativa series
        if (item && item.download && item.download[episodeKey]) {
          const dlUrl = item.download[episodeKey];
          if (dlUrl.includes('player.filmativa.club')) {
            streams.push({ name: `S${season}E${episode} (DL)`, url: filmativaProxyUrl(dlUrl) });
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Server] Error for ${id}:`, err.message);
  }

  res.json({ streams });
});

export default app;
