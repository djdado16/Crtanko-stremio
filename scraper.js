import fs from 'fs';
import path from 'path';

const DB_FILE = './crtanko_db.json';
const SITEMAP_URL = 'https://www.crtanko.xyz/wp-sitemap-posts-post-1.xml';
const CONCURRENCY_LIMIT = 10;
const BATCH_DELAY_MS = 300;

// Read existing database or create new
function readDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading database file, starting fresh:', err.message);
      return {};
    }
  }
  return {};
}

// Write to database
function writeDatabase(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  console.log(`[Scraper] Database saved successfully. Total entries: ${Object.keys(db).length}`);
}

// Fetch sitemap and extract page URLs
async function getSitemapUrls() {
  console.log(`[Scraper] Fetching sitemap: ${SITEMAP_URL}`);
  try {
    const res = await fetch(SITEMAP_URL);
    const text = await res.text();
    const matches = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)];
    const urls = matches.map(m => m[1]);
    console.log(`[Scraper] Found ${urls.length} URLs in sitemap.`);
    return urls;
  } catch (err) {
    console.error('[Scraper] Error fetching sitemap:', err.message);
    return [];
  }
}

// Scrape a single cartoon page details
async function scrapePage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) {
      console.warn(`[Scraper] Failed to fetch ${url} (Status: ${res.status})`);
      return null;
    }
    
    const html = await res.text();
    
    // 1. Extract MoviewpAPI JSON block
    const apiMatch = html.match(/var MoviewpAPI = (\{[\s\S]*?\});/);
    if (!apiMatch) {
      // Not a movie/series post
      return null;
    }
    
    let apiData = {};
    try {
      apiData = JSON.parse(apiMatch[1]);
    } catch (e) {
      console.error(`[Scraper] Error parsing MoviewpAPI JSON for ${url}`);
      return null;
    }
    
    const imdbId = apiData.movieimdb || apiData.tvimdbid;
    if (!imdbId) {
      console.warn(`[Scraper] No IMDb ID found for ${url}`);
      return null;
    }
    
    // 2. Determine type (movie or series)
    const isTv = html.includes('"tvimdbid"') || !!apiData.tvimdbid;
    const type = isTv ? 'series' : 'movie';
    
    // 3. Extract title, poster, year, rating, genres
    const title = apiData.tvtitle || html.match(/<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<span[^>]*>[\s\S]*?<\/span>/g, '').trim() || '';
    
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
    const poster = ogImageMatch ? ogImageMatch[1] : (apiData.tvposter || apiData.noImg || '');
    
    // Parse Year
    let year = 2000;
    const yearMatch = html.match(/\/years\/(\d+)\//);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
    } else {
      const titleYearMatch = html.match(/\((\d{4})\)/);
      if (titleYearMatch) year = parseInt(titleYearMatch[1], 10);
    }
    
    // Parse Genres
    const genres = [];
    const genreMatches = [...html.matchAll(/\/category\/([a-z0-9-]+)\//gi)];
    for (const gm of genreMatches) {
      const g = gm[1].charAt(0).toUpperCase() + gm[1].slice(1);
      if (!genres.includes(g) && !['Movies', 'Tv-series', 'Sinkronizirano', 'Titlovano', 'Kino'].includes(g)) {
        genres.push(g);
      }
    }
    if (genres.length === 0) genres.push('Animation');
    
    const item = {
      url,
      slug: url.replace('https://www.crtanko.xyz/', '').replace(/\//g, ''),
      imdb_id: imdbId,
      type,
      title,
      poster,
      year,
      genres,
      apiData
    };
    
    // 4. If series, extract streaming and download maps
    if (isTv) {
      const streamingMatch = html.match(/var streaming = (\{[\s\S]*?\});/);
      if (streamingMatch) {
        try {
          item.streaming = JSON.parse(streamingMatch[1]);
        } catch (e) {
          console.warn(`[Scraper] Could not parse streaming map for ${title}`);
        }
      }
      
      const downloadMatch = html.match(/var download = (\{[\s\S]*?\});/);
      if (downloadMatch) {
        try {
          item.download = JSON.parse(downloadMatch[1]);
        } catch (e) {
          console.warn(`[Scraper] Could not parse download map for ${title}`);
        }
      }
    }
    
    console.log(`[Scraper] Scraped [${type.toUpperCase()}] ${title} (${year}) - IMDb: ${imdbId}`);
    return item;
  } catch (err) {
    console.error(`[Scraper] Error scraping ${url}:`, err.message);
    return null;
  }
}

// Main Scraping Controller
async function main() {
  const force = process.argv.includes('--force');
  const db = readDatabase();
  const urls = await getSitemapUrls();
  
  if (urls.length === 0) {
    console.log('[Scraper] No URLs found. Exiting.');
    return;
  }
  
  const urlsToScrape = force 
    ? urls 
    : urls.filter(url => !Object.values(db).some(item => item.url === url));
    
  console.log(`[Scraper] ${urlsToScrape.length} new/remaining URLs to scrape.`);
  
  if (urlsToScrape.length === 0) {
    console.log('[Scraper] Database is up to date.');
    return;
  }
  
  // Process in batches
  for (let i = 0; i < urlsToScrape.length; i += CONCURRENCY_LIMIT) {
    const batch = urlsToScrape.slice(i, i + CONCURRENCY_LIMIT);
    console.log(`[Scraper] Processing batch ${i / CONCURRENCY_LIMIT + 1} of ${Math.ceil(urlsToScrape.length / CONCURRENCY_LIMIT)}...`);
    
    const results = await Promise.all(batch.map(url => scrapePage(url)));
    
    let updated = false;
    for (const item of results) {
      if (item) {
        db[item.imdb_id] = item;
        updated = true;
      }
    }
    
    // Save incrementally
    if (updated) {
      writeDatabase(db);
    }
    
    if (i + CONCURRENCY_LIMIT < urlsToScrape.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
  
  console.log('[Scraper] Scraping job finished.');
}

main();
