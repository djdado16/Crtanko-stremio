import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveGoogleDrive, resolveByseEmbed } from './resolver.js';

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

// ─── JELLYFIN RESOLVER ──────────────────────────────────────────────────────────
const JF_BASE = 'https://nl5953.dediseedbox.com:48718';
const JF_API_KEY = 'cbb97ebd740a48b5b127cad73b029667';
const JF_CACHE_TTL = 3600000; // 1 hour
let _jfCache = null;
let _jfCacheTime = 0;

async function buildJellyfinCache() {
  const now = Date.now();
  if (_jfCache && (now - _jfCacheTime) < JF_CACHE_TTL) return _jfCache;
  try {
    const items = [];
    let start = 0;
    while (true) {
      const url = `${JF_BASE}/Items?api_key=${JF_API_KEY}&Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds&Limit=300&StartIndex=${start}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) break;
      const d = await r.json();
      if (!d.Items?.length) break;
      items.push(...d.Items);
      if (items.length >= (d.TotalRecordCount || 0)) break;
      start += 300;
    }
    const lookup = {};
    for (const item of items) {
      const imdb = item.ProviderIds?.Imdb;
      if (imdb && !lookup[imdb]) lookup[imdb] = item.Id;
    }
    _jfCache = lookup;
    _jfCacheTime = now;
    console.log(`[Jellyfin] Cache ready: ${Object.keys(lookup).length} movies`);
    return lookup;
  } catch (e) {
    console.error('[Jellyfin] Cache error:', e.message);
    return _jfCache || {};
  }
}

async function resolveJellyfin(imdbId) {
  const lookup = await buildJellyfinCache();
  const itemId = lookup[imdbId];
  if (!itemId) return null;
  // Use /Videos/ID/stream.mp4 with Static=true for direct streaming
  const url = `${JF_BASE}/Videos/${itemId}/stream.mp4?api_key=${JF_API_KEY}&Static=true`;
  console.log(`[Jellyfin] ${imdbId} → ${url.substring(0, 80)}`);
  return url;
}

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
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
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

    const filmCookies = res.headers.get('set-cookie') || '';
    const cookies = filmCookies.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

    const html = await res.text();
    console.log(`[Filmativa] HTML length: ${html.length}`);

    // ── 1. Try direct m3u8 in HTML ───────────────────────────────────────────
    const directPatterns = [
      /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/,
      /file:\s*["']([^"']+\.m3u8[^"']*)/,
      /source:\s*["']([^"']+\.m3u8[^"']*)/,
      /"file":\s*"([^"]+\.m3u8[^"]*)"/
    ];
    for (const pat of directPatterns) {
      const m = html.match(pat);
      if (m) {
        const url = m[1] || m[0];
        console.log(`[Filmativa] Found direct m3u8: ${url.substring(0, 80)}`);
        return url;
      }
    }

    // ── 2. Look for DMS API URL (player.cvary.org / metaverseid.tk) ──────────
    // Filmativa JS picks a DMS server and calls its API to get the video URL.
    // Common pattern: https://player.cvary.org/api/source/VIDEO_ID
    //               or https://player.cvary.org/player/?vid=VIDEO_ID

    // Extract the video ID embedded in the page (various formats filmativa uses)
    const dmsServers = ['player.cvary.org', 'metaverseid.tk'];
    let videoId = null;

    // Try to extract video ID from the page – filmativa often stores it in a var
    const idPatterns = [
      /var\s+(?:vid|video_id|videoId|id)\s*=\s*["']([^"']+)["']/,
      /data-id=["']([^"']+)["']/,
      /['"](\/(?:embed|video)\/([a-zA-Z0-9_-]{8,})[^'"]*)['"]/,
      // Also check if the embed URL ID itself is the video ID
    ];

    for (const pat of idPatterns) {
      const m = html.match(pat);
      if (m) {
        videoId = m[1] || m[2];
        console.log(`[Filmativa] Extracted video ID: ${videoId}`);
        break;
      }
    }

    // Also look for DMS API URL already constructed in JS
    const dmsApiMatch = html.match(/https?:\/\/(?:player\.cvary\.org|metaverseid\.tk)[^"'\s]*/);
    if (dmsApiMatch) {
      const dmsUrl = dmsApiMatch[0];
      console.log(`[Filmativa] Found DMS API URL: ${dmsUrl}`);
      const m3u8 = await fetchDmsM3u8(dmsUrl, embedUrl, cookies);
      if (m3u8) return m3u8;
    }

    // Try DMS API with the embed ID from the URL
    const embedId = embedUrl.split('/').pop();
    for (const dmsServer of dmsServers) {
      // Common API patterns for these players
      const apiUrls = [
        `https://${dmsServer}/api/source/${embedId}`,
        `https://${dmsServer}/player/?vid=${embedId}`,
        `https://${dmsServer}/?id=${embedId}`,
        `https://${dmsServer}/embed/${embedId}`
      ];
      if (videoId) {
        apiUrls.push(
          `https://${dmsServer}/api/source/${videoId}`,
          `https://${dmsServer}/player/?vid=${videoId}`
        );
      }

      for (const apiUrl of apiUrls) {
        console.log(`[Filmativa] Trying DMS: ${apiUrl}`);
        const m3u8 = await fetchDmsM3u8(apiUrl, embedUrl, cookies);
        if (m3u8) return m3u8;
      }
    }

    // Log for debugging
    const cvarySectionMatch = html.match(/cvary[\s\S]{0,500}/);
    if (cvarySectionMatch) {
      console.log(`[Filmativa] cvary context: ${cvarySectionMatch[0].substring(0, 300).replace(/\n/g, ' ')}`);
    }
    console.error(`[Filmativa] No m3u8 found after all attempts`);
    return null;

  } catch (err) {
    console.error(`[Filmativa] Error: ${err.message}`);
    return null;
  }
}

/** Try to extract an m3u8 URL from a DMS player API response. */
async function fetchDmsM3u8(apiUrl, referer, cookies) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': referer,
      'Origin': 'https://player.filmativa.club'
    };
    if (cookies) headers['Cookie'] = cookies;

    const r = await fetch(apiUrl, { headers });
    if (!r.ok) return null;

    const body = await r.text();
    const patterns = [
      /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/,
      /"file":\s*"([^"]+\.m3u8[^"]*)"/,
      /file:\s*["']([^"']+\.m3u8[^"']*)/
    ];
    for (const pat of patterns) {
      const m = body.match(pat);
      if (m) {
        const url = m[1] || m[0];
        console.log(`[Filmativa] DMS ${apiUrl} → m3u8: ${url.substring(0, 80)}`);
        return url;
      }
    }
    // Log first 200 chars of response for debugging
    console.log(`[Filmativa] DMS ${apiUrl} → ${r.status}, body: ${body.substring(0, 200).replace(/\n/g, ' ')}`);
    return null;
  } catch (_) {
    return null;
  }
}



// ─── HELPER: resolve roda.php page to direct source URL ─────────────────────
async function resolveRodaPhp(rodaUrl) {
  try {
    const html = await (await fetch(rodaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.crtanko.xyz/' }
    })).text();
    const m = html.match(/<source\s+src="([^"]+)"/);
    return m ? m[1] : null;
  } catch (e) {
    console.error('[roda.php]', e.message);
    return null;
  }
}

// ─── HELPER: resolve filemoon.php page → follow iframe ───────────────────────
async function resolveFilemoonPhp(filemoonUrl) {
  try {
    const html = await (await fetch(filemoonUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.crtanko.xyz/' }
    })).text();
    // Could be a direct source
    const src = html.match(/<source[^>]+src="(https?:\/\/[^"]+)"/);
    if (src) return src[1];
    // Or roda.php style source
    const rodaSrc = html.match(/<source\s+src="([^"]+)"/);
    if (rodaSrc) return rodaSrc[1];
    // Otherwise it has an iframe pointing to another player (byse, jockantv etc.)
    // These require JavaScript/CAPTCHA – can't resolve server-side
    const iframe = html.match(/iframe[^>]+src="(https?:\/\/[^"]+)"/);
    if (iframe) {
      console.log(`[filemoon.php] iframe → ${iframe[1].substring(0, 60)} (unresolvable SPA)`);
    }
    return null;
  } catch (e) {
    console.error('[filemoon.php]', e.message);
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
      const imdbId = id;
      const item = db[imdbId];

      // ① Primary: Jellyfin direct MP4 (covers 26% of all movies)
      const jfUrl = await resolveJellyfin(imdbId);
      if (jfUrl) {
        streams.push({ name: 'Crtanko', url: jfUrl });
        console.log(`[Movie] Jellyfin stream found for ${imdbId}`);
      }

      // ② Fallback: URL-based resolvers (roda.php, filmativa)
      if (streams.length === 0 && item?.apiData) {
        const apiData = item.apiData;

        // SD stream
        for (const [qual, url] of [['SD', apiData.videolink], ['HD', apiData.videolinkhd]]) {
          if (!url) continue;
          let resolved = null;

          if (url.includes('roda.php')) {
            resolved = await resolveRodaPhp(url);
          } else if (url.includes('filemoon.php')) {
            resolved = await resolveFilemoonPhp(url);
          } else if (url.includes('player.filmativa.club')) {
            resolved = await resolveFilmativaM3u8(url);
          }

          if (resolved) streams.push({ name: `Crtanko ${qual}`, url: resolved });
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
        if (item?.streaming?.[episodeKey]) {
          const epUrl = item.streaming[episodeKey];

          if (epUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)) {
            // Google Drive
            const fileId = epUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)[1];
            console.log(`[Series] GD ${episodeKey}: ${fileId}`);
            const directUrl = await resolveGoogleDrive(fileId);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });

          } else if (epUrl.includes('roda.php')) {
            console.log(`[Series] roda.php ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveRodaPhp(epUrl);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });

          } else if (epUrl.includes('filemoon.php')) {
            console.log(`[Series] filemoon.php ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveFilemoonPhp(epUrl);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });

          } else if (epUrl.includes('player.filmativa.club')) {
            console.log(`[Series] Filmativa ${episodeKey}: ${epUrl}`);
            const m3u8 = await resolveFilmativaM3u8(epUrl);
            if (m3u8) streams.push({ name: `S${season}E${episode} (HD)`, url: m3u8 });

          } else if (epUrl.includes('bysevepoin.com') || epUrl.includes('bysezoxexe.com')) {
            console.log(`[Series] Byse ${episodeKey}: ${epUrl}`);
            const directUrl = await resolveByseEmbed(epUrl);
            if (directUrl) streams.push({ name: `S${season}E${episode}`, url: directUrl });
          }
        }

        // Download link as fallback
        if (item?.download?.[episodeKey]) {
          const dlUrl = item.download[episodeKey];
          if (streams.length === 0) {
            if (dlUrl.includes('roda.php')) {
              const u = await resolveRodaPhp(dlUrl);
              if (u) streams.push({ name: `S${season}E${episode} (DL)`, url: u });
            } else if (dlUrl.includes('player.filmativa.club')) {
              const m3u8 = await resolveFilmativaM3u8(dlUrl);
              if (m3u8) streams.push({ name: `S${season}E${episode} (DL)`, url: m3u8 });
            }
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
