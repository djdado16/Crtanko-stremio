import fs from 'fs';

const DB_FILE = './crtanko_db.json';
const CONCURRENCY_LIMIT = 30;
const BATCH_DELAY_MS = 100;

async function scrapePoster(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
    return ogImageMatch ? ogImageMatch[1] : null;
  } catch (err) {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('Database not found.');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const items = Object.values(db);
  
  // Filter movies that need poster updates
  const itemsToUpdate = items.filter(item => 
    !item.poster || 
    item.poster.includes('noimage.jpg')
  );
  
  console.log(`Found ${itemsToUpdate.length} items to update poster for.`);
  if (itemsToUpdate.length === 0) {
    console.log('All posters are up to date.');
    return;
  }

  for (let i = 0; i < itemsToUpdate.length; i += CONCURRENCY_LIMIT) {
    const batch = itemsToUpdate.slice(i, i + CONCURRENCY_LIMIT);
    console.log(`Updating batch ${i / CONCURRENCY_LIMIT + 1} of ${Math.ceil(itemsToUpdate.length / CONCURRENCY_LIMIT)}...`);
    
    await Promise.all(batch.map(async (item) => {
      const posterUrl = await scrapePoster(item.url);
      if (posterUrl) {
        db[item.imdb_id].poster = posterUrl;
        console.log(`[UPDATED] ${item.title} -> ${posterUrl}`);
      }
    }));

    // Save incrementally
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    
    if (i + CONCURRENCY_LIMIT < itemsToUpdate.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log('Poster update completed successfully!');
}

main();
