import { URLSearchParams } from 'url';

/**
 * Resolves a Google Drive preview file ID to a direct download link that Stremio can stream.
 * @param {string} fileId 
 * @returns {Promise<string>}
 */
export async function resolveGoogleDrive(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const html = await res.text();
    
    // Parse hidden inputs from download warning page
    const inputMatches = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)"/g)];
    if (inputMatches.length > 0) {
      const params = new URLSearchParams();
      for (const match of inputMatches) {
        params.append(match[1], match[2]);
      }
      
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
 * Resolves movie stream links from Crtanko page data.
 * @param {string} imdbId 
 * @param {object} apiData - MoviewpAPI object from page
 * @returns {Promise<Array<{name: string, url?: string, externalUrl?: string}>>}
 */
export async function resolveCrtankoMovie(imdbId, apiData) {
  const streams = [];
  
  // 1. Resolve SD stream (usually roda.php or filemoon.php)
  if (apiData.videolink) {
    if (apiData.videolink.includes('roda.php')) {
      try {
        console.log(`[Movie Resolver] Resolving roda.php: ${apiData.videolink}`);
        const res = await fetch(apiData.videolink, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.crtanko.xyz/'
          }
        });
        const html = await res.text();
        const sourceMatch = html.match(/<source\s+src="([^"]+)"/);
        if (sourceMatch) {
          streams.push({
            name: "Crtanko SD (Direct Player)",
            url: sourceMatch[1] // Direct mp4 link
          });
        }
      } catch (err) {
        console.error(`[Movie Resolver] Error resolving roda.php:`, err.message);
      }
    } else if (apiData.videolink.includes('filemoon.php')) {
      // Return filemoon.php as an external link since upbolt.to has CF protection
      streams.push({
        name: "Crtanko SD (Web Player)",
        externalUrl: apiData.videolink
      });
    } else {
      streams.push({
        name: "Crtanko SD Link",
        externalUrl: apiData.videolink
      });
    }
  }
  
  // 2. Resolve HD stream (usually filmativa.club or bysezoxexe.com embed)
  if (apiData.videolinkhd) {
    if (apiData.videolinkhd.includes('player.filmativa.club')) {
      console.log(`[Movie Resolver] Resolving filmativa.club HD: ${apiData.videolinkhd}`);
      const directUrl = await resolveFilmativa(apiData.videolinkhd);
      if (directUrl) {
        streams.push({
          name: "Crtanko HD (Direct Player)",
          url: directUrl
        });
      } else {
        streams.push({
          name: "Crtanko HD (Web Player)",
          externalUrl: apiData.videolinkhd
        });
      }
    } else {
      streams.push({
        name: "Crtanko HD (Web Player)",
        externalUrl: apiData.videolinkhd
      });
    }
  }
  
  return streams;
}

/**
 * Resolves a filmativa.club embed player link to a direct .m3u8 stream.
 * @param {string} embedUrl 
 * @returns {Promise<string|null>}
 */
export async function resolveFilmativa(embedUrl) {
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.crtanko.xyz/'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m3u8Match = html.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
    return m3u8Match ? m3u8Match[0] : null;
  } catch (err) {
    console.error(`[Filmativa Resolver] Error resolving ${embedUrl}:`, err.message);
    return null;
  }
}
