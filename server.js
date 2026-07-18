import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveGoogleDrive, resolveCrtankoMovie, resolveFilmativa, resolveByseEmbed, resolveFilemoon } from './resolver.js';

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

// Manifest definition
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

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

// Catalog endpoint
app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  const search = req.query.search || '';
  const db = loadDatabase();

  let metas = Object.values(db)
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

// ─── HLS FILMATIVA PROXY ──────────────────────────────────────────────────────
// Scans a /secip/ CDN URL for a base64-encoded IPv4 segment and returns it.
function extractIpFromSecipUrl(cdnUrl) {
  try {
    const segments = new URL(cdnUrl).pathname.split('/');
    for (const seg of segments) {
      if (seg.length < 8) continue;
      try {
        const decoded = Buffer.from(seg, 'base64').toString('utf-8');
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(decoded)) return decoded;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Replaces the base64-encoded IP inside a /secip/ CDN URL with a new IP.
function swapIpInSecipUrl(cdnUrl, newIp) {
  try {
    const url = new URL(cdnUrl);
    const segments = url.pathname.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].length < 8) continue;
      try {
        const decoded = Buffer.from(segments[i], 'base64').toString('utf-8');
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(decoded)) {
          segments[i] = Buffer.from(newIp).toString('base64');
          url.pathname = segments.join('/');
          return url.toString();
        }
      } catch (_) {}
    }
  } catch (_) {}
  return cdnUrl;
}

/**
 * HLS proxy for Filmativa streams.
 *
 * Strategy:
 *  1. Re-resolve the filmativa embed URL from THIS Vercel function invocation.
 *     → Filmativa generates a /secip/ CDN URL whose IP segment = this function's outbound IP.
 *  2. Fetch the .m3u8 playlist from the CDN from the SAME invocation / IP.
 *     → IP check passes (token IP == requesting IP).
 *  3. Replace the Vercel IP in every TS segment URL with the Stremio user's real IP.
 *     → Stremio fetches TS segments directly from CDN; CDN sees user IP == URL IP.
 *  4. Return the rewritten playlist to Stremio.
 */
app.get('/hls/filmativa', async (req, res) => {
  const { embed } = req.query;
  if (!embed) return res.status(400).send('Missing embed parameter');

  // User's real IP (Vercel puts it in x-forwarded-for)
  const userIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                 req.headers['x-real-ip'] || '';

  try {
    const embedUrl = Buffer.from(embed, 'base64url').toString('utf-8');
    console.log(`[HLS] Re-resolving filmativa: ${embedUrl}`);

    // Step 1 – resolve from THIS function's IP, get cookies too
    const filmRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.crtanko.xyz/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!filmRes.ok) {
      console.error(`[HLS] Filmativa embed HTTP ${filmRes.status}`);
      return res.status(502).send('Could not load filmativa embed');
    }

    // Capture any cookies filmativa sets, to forward to CDN
    const setCookie = filmRes.headers.get('set-cookie') || '';
    const cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    if (cookies) console.log(`[HLS] Filmativa cookies: ${cookies}`);

    const html = await filmRes.text();
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (!m3u8Match) {
      console.error('[HLS] No m3u8 URL found in filmativa embed HTML');
      return res.status(502).send('Could not find m3u8 in filmativa embed');
    }
    const m3u8Url = m3u8Match[0];

    const vercelIp = extractIpFromSecipUrl(m3u8Url);
    console.log(`[HLS] CDN URL IP (Vercel): ${vercelIp}, User IP: ${userIp}`);
    console.log(`[HLS] Fetching m3u8: ${m3u8Url.substring(0, 100)}...`);

    // Step 2 – fetch the playlist from CDN (same Vercel IP → token IP match)
    // Use full browser headers including Sec-Fetch-* which Chrome sends for media requests
    const cdnHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://player.filmativa.club/',
      'Origin': 'https://player.filmativa.club',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    };
    if (cookies) cdnHeaders['Cookie'] = cookies;

    let cdnRes;
    try {
      cdnRes = await fetch(m3u8Url, { headers: cdnHeaders });
    } catch (fetchErr) {
      const cause = fetchErr.cause;
      console.error(`[HLS] CDN fetch failed - cause: ${cause?.code || cause?.message || fetchErr.message}`);
      return res.status(502).send(`CDN connection failed: ${cause?.code || fetchErr.message}`);
    }

    if (!cdnRes.ok) {
      console.error(`[HLS] CDN returned HTTP ${cdnRes.status} for m3u8`);
      return res.status(502).send(`CDN error: ${cdnRes.status}`);
    }

    const playlistText = await cdnRes.text();
    console.log(`[HLS] Playlist fetched OK – ${playlistText.split('\n').length} lines`);

    // Step 3 – rewrite TS URLs: replace Vercel IP with user's real IP
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    const rewritten = playlistText.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return trimmed;
      const tsUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).toString();
      const finalUrl = (vercelIp && userIp) ? swapIpInSecipUrl(tsUrl, userIp) : tsUrl;
      return finalUrl;
    }).join('\n');

    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);

  } catch (err) {
    console.error('[HLS] Error:', err.message, err.cause?.code);
    res.status(500).send(`HLS proxy error: ${err.message}`);
  }
});


// ─── STREAM ENDPOINT ──────────────────────────────────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  console.log(`[Server] Stream requested: type=${type}, id=${id}`);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');

  const db = loadDatabase();
  const streams = [];

  // Helper – wrap a filmativa embed URL behind our HLS proxy
  function filmativaProxyUrl(embedUrl) {
    const enc = Buffer.from(embedUrl).toString('base64url');
    return `${protocol}://${host}/hls/filmativa?embed=${enc}`;
  }

  try {
    if (type === 'movie') {
      const item = db[id];
      if (item && item.apiData) {
        // For filmativa links in movies, use the HLS proxy (re-resolves inside proxy endpoint)
        const apiData = item.apiData;

        // SD stream
        if (apiData.videolink) {
          if (apiData.videolink.includes('roda.php')) {
            try {
              const html = await (await fetch(apiData.videolink, {
                headers: {
                  'User-Agent': 'Mozilla/5.0',
                  'Referer': 'https://www.crtanko.xyz/'
                }
              })).text();
              const m = html.match(/<source\s+src="([^"]+)"/);
              if (m) streams.push({ name: 'Crtanko SD', url: m[1] });
            } catch (e) { console.error('[Movie] roda.php error:', e.message); }
          } else if (apiData.videolink.includes('player.filmativa.club')) {
            streams.push({ name: 'Crtanko SD', url: filmativaProxyUrl(apiData.videolink) });
          }
        }

        // HD stream
        if (apiData.videolinkhd) {
          if (apiData.videolinkhd.includes('player.filmativa.club')) {
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
            // Filmativa → use HLS proxy (re-resolves inside proxy)
            console.log(`[Series] Filmativa episode ${episodeKey}: ${epUrl}`);
            streams.push({
              name: `S${season}E${episode} (HD)`,
              url: filmativaProxyUrl(epUrl)
            });

          } else if (epUrl.includes('bysevepoin.com') || epUrl.includes('bysezoxexe.com')) {
            console.log(`[Series] Byse episode ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveByseEmbed(epUrl);
            if (directUrl) {
              streams.push({ name: `S${season}E${episode}`, url: directUrl });
            }

          } else if (epUrl.includes('filemoon')) {
            console.log(`[Series] Filemoon episode ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveFilemoon(epUrl);
            if (directUrl) {
              streams.push({ name: `S${season}E${episode}`, url: directUrl });
            }
          }
        }

        // Download links as fallback
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
