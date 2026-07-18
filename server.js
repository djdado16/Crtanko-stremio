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

// ─── FILMATIVA RESOLVER ───────────────────────────────────────────────────────
/**
 * Fetches a filmativa embed page and extracts the direct .m3u8 CDN URL.
 *
 * KEY INSIGHT: The filmativa CDN (4fw4gd.cfglobalcdn.com) blocks ALL
 * datacenter IPs (AWS, Cloudflare, etc.) but allows residential IPs.
 * By returning the direct m3u8 URL to Stremio instead of proxying it,
 * Stremio/ExoPlayer fetches the CDN directly from the user's residential
 * IP – which the CDN allows.
 *
 * The IP embedded in the /secip/ URL path is part of the HMAC token
 * signature (used to prevent link sharing), but the CDN does NOT check
 * requesting IP == embedded IP. Normal browser users watch with their
 * own IPs just fine.
 */
async function resolveFilmativaM3u8(embedUrl) {
  try {
    console.log(`[Filmativa] Resolving: ${embedUrl}`);
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.crtanko.xyz/',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!res.ok) {
      console.error(`[Filmativa] HTTP ${res.status} for ${embedUrl}`);
      return null;
    }

    const html = await res.text();

    // Match the m3u8 URL directly in the HTML/JS
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (!m3u8Match) {
      console.error(`[Filmativa] No m3u8 URL found in embed HTML`);
      return null;
    }

    const m3u8Url = m3u8Match[0];
    console.log(`[Filmativa] Resolved m3u8: ${m3u8Url.substring(0, 80)}...`);
    return m3u8Url;

  } catch (err) {
    console.error(`[Filmativa] Error: ${err.message}`);
    return null;
  }
}

// ─── STREAM ENDPOINT ─────────────────────────────────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  console.log(`[Server] Stream: type=${type}, id=${id}`);

  const db = loadDatabase();
  const streams = [];

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
            const m3u8 = await resolveFilmativaM3u8(apiData.videolink);
            if (m3u8) streams.push({ name: 'Crtanko SD', url: m3u8 });
          }
        }

        // HD stream
        if (apiData.videolinkhd) {
          if (apiData.videolinkhd.includes('player.filmativa.club')) {
            const m3u8 = await resolveFilmativaM3u8(apiData.videolinkhd);
            if (m3u8) streams.push({ name: 'Crtanko HD', url: m3u8 });
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
            // Filmativa: resolve to direct m3u8 URL, let Stremio fetch from user's IP
            console.log(`[Series] Filmativa episode ${episodeKey}: ${epUrl}`);
            const m3u8 = await resolveFilmativaM3u8(epUrl);
            if (m3u8) {
              streams.push({ name: `S${season}E${episode} (HD)`, url: m3u8 });
            }

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

        // Download link as fallback
        if (item && item.download && item.download[episodeKey]) {
          const dlUrl = item.download[episodeKey];
          if (dlUrl.includes('player.filmativa.club')) {
            const m3u8 = await resolveFilmativaM3u8(dlUrl);
            if (m3u8) streams.push({ name: `S${season}E${episode} (DL)`, url: m3u8 });
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
