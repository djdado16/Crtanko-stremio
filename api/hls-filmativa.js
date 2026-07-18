/**
 * Vercel Edge Function – runs on Cloudflare Workers (BoringSSL / Chrome TLS fingerprint).
 * This is the key difference from the regular Node.js serverless function which uses
 * undici/OpenSSL and gets blocked by the filmativa CDN's TLS fingerprint check.
 *
 * Flow:
 *  1. Decode the base64url-encoded filmativa embed URL from ?embed=
 *  2. Fetch the filmativa embed page (Chrome TLS ✓)
 *  3. Extract the .m3u8 CDN URL from the HTML
 *  4. Fetch the .m3u8 playlist from the CDN (Chrome TLS ✓ – same function invocation IP)
 *  5. Rewrite TS segment URLs: swap the embedded "Filmativa server IP" → user's real IP
 *  6. Return the rewritten playlist to Stremio
 *
 * Stremio then fetches TS segments DIRECTLY from the CDN using the user's IP,
 * which matches the IP we've swapped into each segment URL.
 */

export const config = { runtime: 'edge' };

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Decode base64url → string */
function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

/** Scan /secip/ CDN URL for a base64-encoded IPv4 segment and return it. */
function extractIpFromSecipUrl(cdnUrl) {
  try {
    const segments = new URL(cdnUrl).pathname.split('/');
    for (const seg of segments) {
      if (seg.length < 8) continue;
      try {
        const decoded = atob(seg.replace(/-/g, '+').replace(/_/g, '/'));
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(decoded)) return decoded;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/** Replace the base64-encoded IP in a /secip/ CDN URL with newIp. */
function swapIpInSecipUrl(cdnUrl, newIp) {
  try {
    const url = new URL(cdnUrl);
    const segments = url.pathname.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].length < 8) continue;
      try {
        const decoded = atob(segments[i].replace(/-/g, '+').replace(/_/g, '/'));
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(decoded)) {
          segments[i] = btoa(newIp);
          url.pathname = segments.join('/');
          return url.toString();
        }
      } catch (_) {}
    }
  } catch (_) {}
  return cdnUrl;
}

export default async function handler(req) {
  // Allow HEAD (Stremio health-checks) and GET
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'application/x-mpegURL', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const url = new URL(req.url);
  const embed = url.searchParams.get('embed');
  if (!embed) return new Response('Missing embed parameter', { status: 400 });

  // User's real IP forwarded by Vercel/Cloudflare
  const userIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '';

  let embedUrl;
  try {
    embedUrl = fromBase64url(embed);
  } catch (_) {
    return new Response('Invalid embed encoding', { status: 400 });
  }

  console.log(`[Edge HLS] embed: ${embedUrl}`);
  console.log(`[Edge HLS] userIp: ${userIp}`);

  // ── Step 1: Fetch filmativa embed page ───────────────────────────────────────
  let filmRes;
  try {
    filmRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
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
  } catch (err) {
    console.error(`[Edge HLS] filmativa fetch error: ${err.message}`);
    return new Response(`filmativa fetch failed: ${err.message}`, { status: 502 });
  }

  if (!filmRes.ok) {
    return new Response(`filmativa HTTP ${filmRes.status}`, { status: 502 });
  }

  // Capture cookies filmativa sets (pass to CDN)
  const setCookie = filmRes.headers.get('set-cookie') || '';
  const cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

  const html = await filmRes.text();

  // ── Step 2: Extract m3u8 URL ─────────────────────────────────────────────────
  const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (!m3u8Match) {
    console.error('[Edge HLS] No m3u8 found in filmativa HTML');
    return new Response('No m3u8 URL found in filmativa embed', { status: 502 });
  }
  const m3u8Url = m3u8Match[0];
  const embeddedIp = extractIpFromSecipUrl(m3u8Url);
  console.log(`[Edge HLS] m3u8 found, embeddedIp=${embeddedIp}, userIp=${userIp}`);

  // ── Step 3: Fetch the m3u8 playlist from CDN ─────────────────────────────────
  const cdnHeaders = {
    'User-Agent': BROWSER_UA,
    'Accept': '*/*',
    'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7',
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
  } catch (err) {
    console.error(`[Edge HLS] CDN fetch error: ${err.message}`);
    return new Response(`CDN fetch failed: ${err.message}`, { status: 502 });
  }

  if (!cdnRes.ok) {
    console.error(`[Edge HLS] CDN HTTP ${cdnRes.status}`);
    return new Response(`CDN error: ${cdnRes.status}`, { status: 502 });
  }

  const playlistText = await cdnRes.text();
  console.log(`[Edge HLS] playlist OK – ${playlistText.split('\n').length} lines`);

  // ── Step 4: Rewrite TS segment URLs (swap embedded IP → user IP) ─────────────
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  const rewritten = playlistText.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return trimmed;

    const tsUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).toString();
    const finalUrl = (embeddedIp && userIp) ? swapIpInSecipUrl(tsUrl, userIp) : tsUrl;
    return finalUrl;
  }).join('\n');

  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-mpegURL',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
