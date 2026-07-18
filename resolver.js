import { URLSearchParams } from 'url';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.crtanko.xyz/'
};

/**
 * Resolves a Google Drive preview file ID to a direct download link.
 */
export async function resolveGoogleDrive(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const html = await res.text();
    const inputMatches = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)"/g)];
    if (inputMatches.length > 0) {
      const params = new URLSearchParams();
      for (const match of inputMatches) params.append(match[1], match[2]);
      const actionMatch = html.match(/<form [^>]*action="([^"]+)"/);
      const actionUrl = actionMatch ? actionMatch[1] : 'https://drive.usercontent.google.com/download';
      return `${actionUrl}?${params.toString()}`;
    }
    return url;
  } catch (err) {
    console.error(`[GD Resolver] Error resolving ${fileId}:`, err.message);
    return url;
  }
}

/**
 * Resolves a filmativa.club embed to a direct .m3u8 stream URL.
 */
export async function resolveFilmativa(embedUrl, userIp = null) {
  try {
    const headers = { ...BROWSER_HEADERS };
    if (userIp) {
      headers['X-Forwarded-For'] = userIp;
      headers['X-Real-IP'] = userIp;
      console.log(`[Filmativa] Forwarding user IP ${userIp}`);
    }
    const res = await fetch(embedUrl, { headers });
    if (!res.ok) return null;
    const html = await res.text();
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    return m3u8Match ? m3u8Match[0] : null;
  } catch (err) {
    console.error(`[Filmativa] Error resolving ${embedUrl}:`, err.message);
    return null;
  }
}

/**
 * Resolves a bysevepoin.com or bysezoxexe.com embed to a direct stream URL.
 * These hosts use the same embed player pattern as filmativa.
 */
export async function resolveByseEmbed(embedUrl) {
  try {
    console.log(`[Byse Resolver] Fetching: ${embedUrl}`);
    const res = await fetch(embedUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) {
      console.error(`[Byse Resolver] HTTP ${res.status} for ${embedUrl}`);
      return null;
    }
    const html = await res.text();

    // Priority 1: m3u8 stream
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (m3u8Match) {
      console.log(`[Byse Resolver] Found m3u8: ${m3u8Match[0].substring(0, 60)}`);
      return m3u8Match[0];
    }

    // Priority 2: "file":"https://..." JW Player / plyr pattern
    const fileMatch = html.match(/"file"\s*:\s*["'](https?:\/\/[^"']+)["']/);
    if (fileMatch) {
      console.log(`[Byse Resolver] Found file: ${fileMatch[1].substring(0, 60)}`);
      return fileMatch[1];
    }

    // Priority 3: direct mp4
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      console.log(`[Byse Resolver] Found mp4: ${mp4Match[0].substring(0, 60)}`);
      return mp4Match[0];
    }

    // Priority 4: <source src="...">
    const srcMatch = html.match(/<source[^>]+src="(https?:\/\/[^"]+)"/);
    if (srcMatch) {
      console.log(`[Byse Resolver] Found source src: ${srcMatch[1].substring(0, 60)}`);
      return srcMatch[1];
    }

    console.warn(`[Byse Resolver] No video URL found in ${embedUrl}`);
    return null;
  } catch (err) {
    console.error(`[Byse Resolver] Error: ${err.message}`);
    return null;
  }
}

/**
 * Resolves a filemoon.to embed to a direct stream URL.
 */
export async function resolveFilemoon(embedUrl) {
  try {
    console.log(`[Filemoon] Fetching: ${embedUrl}`);
    const res = await fetch(embedUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) {
      console.error(`[Filemoon] HTTP ${res.status} for ${embedUrl}`);
      return null;
    }
    const html = await res.text();

    // Priority 1: m3u8
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (m3u8Match) {
      console.log(`[Filemoon] Found m3u8: ${m3u8Match[0].substring(0, 60)}`);
      return m3u8Match[0];
    }

    // Priority 2: "file":"https://..." in jwplayer/plyr setup
    const fileMatch = html.match(/"file"\s*:\s*["'](https?:\/\/[^"']+)["']/);
    if (fileMatch) {
      console.log(`[Filemoon] Found file: ${fileMatch[1].substring(0, 60)}`);
      return fileMatch[1];
    }

    // Priority 3: mp4
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
    if (mp4Match) {
      console.log(`[Filemoon] Found mp4: ${mp4Match[0].substring(0, 60)}`);
      return mp4Match[0];
    }

    // Priority 4: source src
    const srcMatch = html.match(/<source[^>]+src="(https?:\/\/[^"]+)"/);
    if (srcMatch) return srcMatch[1];

    console.warn(`[Filemoon] No video URL found in ${embedUrl}`);
    return null;
  } catch (err) {
    console.error(`[Filemoon] Error: ${err.message}`);
    return null;
  }
}

/**
 * Resolves movie stream links from Crtanko page data.
 */
export async function resolveCrtankoMovie(imdbId, apiData, userIp = null) {
  const streams = [];

  // 1. Resolve SD stream (videolink)
  if (apiData.videolink) {
    if (apiData.videolink.includes('roda.php')) {
      try {
        console.log(`[Movie] Resolving roda.php: ${apiData.videolink}`);
        const res = await fetch(apiData.videolink, { headers: BROWSER_HEADERS });
        const html = await res.text();
        const sourceMatch = html.match(/<source\s+src="([^"]+)"/);
        if (sourceMatch) {
          streams.push({ name: 'Crtanko SD', url: sourceMatch[1] });
        } else {
          console.warn(`[Movie] No source found in roda.php for ${imdbId}`);
        }
      } catch (err) {
        console.error(`[Movie] roda.php error: ${err.message}`);
      }
    } else if (apiData.videolink.includes('player.filmativa.club')) {
      // Some movies have filmativa as the SD source
      console.log(`[Movie] Resolving filmativa SD: ${apiData.videolink}`);
      const directUrl = await resolveFilmativa(apiData.videolink, userIp);
      if (directUrl) {
        streams.push({ name: 'Crtanko SD', url: directUrl });
      }
    } else if (apiData.videolink.includes('filemoon')) {
      const directUrl = await resolveFilemoon(apiData.videolink);
      if (directUrl) {
        streams.push({ name: 'Crtanko SD', url: directUrl });
      }
    }
    // filemoon.php and other external links are skipped (no native playback)
  }

  // 2. Resolve HD stream (videolinkhd)
  if (apiData.videolinkhd) {
    if (apiData.videolinkhd.includes('player.filmativa.club')) {
      console.log(`[Movie] Resolving filmativa HD: ${apiData.videolinkhd}`);
      const directUrl = await resolveFilmativa(apiData.videolinkhd, userIp);
      if (directUrl) {
        streams.push({ name: 'Crtanko HD', url: directUrl });
      }
    } else if (apiData.videolinkhd.includes('roda.php')) {
      try {
        const res = await fetch(apiData.videolinkhd, { headers: BROWSER_HEADERS });
        const html = await res.text();
        const sourceMatch = html.match(/<source\s+src="([^"]+)"/);
        if (sourceMatch) streams.push({ name: 'Crtanko HD', url: sourceMatch[1] });
      } catch (err) {
        console.error(`[Movie] roda.php HD error: ${err.message}`);
      }
    } else if (apiData.videolinkhd.includes('filemoon')) {
      const directUrl = await resolveFilemoon(apiData.videolinkhd);
      if (directUrl) streams.push({ name: 'Crtanko HD', url: directUrl });
    }
  }

  return streams;
}
