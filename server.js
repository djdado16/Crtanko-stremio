import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveGoogleDrive, resolveCrtankoMovie, resolveFilmativa } from './resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'crtanko_db.json');

const app = express();

app.use(cors());
app.use(express.json());

// Helper to load current database
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading database file:', err.message);
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
  ]
};

// Root endpoint redirect or description
app.get('/', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const manifestUrl = `${protocol}://${host}/manifest.json`;
  const stremioUrl = manifestUrl.replace(/^https?/, 'stremio');

  res.send(`
    <html>
      <head>
        <title>Crtanko Stremio Addon</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #121214; color: #fff; }
          a { color: #8a2be2; text-decoration: none; font-weight: bold; border: 2px solid #8a2be2; padding: 10px 20px; border-radius: 5px; }
          a:hover { background-color: #8a2be2; color: #fff; }
          code { background: #222; padding: 5px 10px; border-radius: 3px; border: 1px solid #333; }
        </style>
      </head>
      <body>
        <h1>Crtanko Stremio Addon</h1>
        <p>Instalirajte addon kopiranjem donjeg linka u Stremio Addons pretragu:</p>
        <p style="font-size: 1.2em; margin: 20px 0;">
          <code>${manifestUrl}</code>
        </p>
        <a href="${stremioUrl}">Instaliraj u Stremio</a>
      </body>
    </html>
  `);
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

// Catalog endpoint (browse and pagination)
app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  const skip = parseInt(req.query.skip || 0, 10);
  
  console.log(`[Server] Catalog requested: type=${type}, id=${id}, skip=${skip}`);
  
  const db = loadDatabase();
  const items = Object.values(db).filter(item => item.type === type);
  
  // Map to Stremio Meta Preview format
  const metas = items.map(item => ({
    id: item.imdb_id,
    type: item.type,
    name: item.title,
    poster: item.poster,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: item.genres
  }));
  
  res.json({
    metas: metas.slice(skip, skip + 100)
  });
});

// Catalog Search endpoint
app.get('/catalog/:type/:id/search=:query.json', (req, res) => {
  const { type, id, query } = req.params;
  const cleanQuery = decodeURIComponent(query).toLowerCase();
  
  console.log(`[Server] Catalog search requested: type=${type}, query="${cleanQuery}"`);
  
  const db = loadDatabase();
  const items = Object.values(db).filter(item => 
    item.type === type && 
    (item.title.toLowerCase().includes(cleanQuery) || item.slug.toLowerCase().includes(cleanQuery))
  );
  
  const metas = items.map(item => ({
    id: item.imdb_id,
    type: item.type,
    name: item.title,
    poster: item.poster,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: item.genres
  }));
  
  res.json({ metas });
});

// Stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  console.log(`[Server] Stream requested: type=${type}, id=${id}`);
  
  const db = loadDatabase();
  const streams = [];
  
  try {
    if (type === 'movie') {
      // Find movie by IMDb ID
      const item = db[id];
      if (item && item.apiData) {
        // Resolve stream URLs
        const resolvedStreams = await resolveCrtankoMovie(id, item.apiData);
        streams.push(...resolvedStreams);
        
        // Always provide a fallback to open in browser
        streams.push({
          name: "Crtanko Web Player (Browser)",
          externalUrl: item.url
        });
      }
    } else if (type === 'series') {
      // Stremio series ID format is: "ttXXXXXX:season:episode"
      const parts = id.split(':');
      if (parts.length === 3) {
        const imdbId = parts[0];
        const season = parts[1];
        const episode = parts[2];
        const episodeKey = `s${season}_${episode}`;
        
        const item = db[imdbId];
        if (item) {
          let resolved = false;
          
          // Try to resolve Google Drive or Filmativa link first
          if (item.streaming && item.streaming[episodeKey]) {
            const gdUrl = item.streaming[episodeKey];
            const gdIdMatch = gdUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (gdIdMatch) {
              const fileId = gdIdMatch[1];
              console.log(`[Server] Resolving GD link for episode ${episodeKey} (File ID: ${fileId})`);
              const directStreamUrl = await resolveGoogleDrive(fileId);
              if (directStreamUrl) {
                streams.push({
                  name: `Crtanko S${season}E${episode} (Direct Player)`,
                  url: directStreamUrl
                });
                resolved = true;
              }
            } else if (gdUrl.includes('player.filmativa.club')) {
              console.log(`[Server] Resolving Filmativa link for episode ${episodeKey}: ${gdUrl}`);
              const directStreamUrl = await resolveFilmativa(gdUrl);
              if (directStreamUrl) {
                streams.push({
                  name: `Crtanko S${season}E${episode} (Direct Player)`,
                  url: directStreamUrl
                });
                resolved = true;
              } else {
                streams.push({
                  name: `Crtanko S${season}E${episode} (Web Player)`,
                  externalUrl: gdUrl
                });
              }
            } else {
              streams.push({
                name: `Crtanko S${season}E${episode} (Web Player)`,
                externalUrl: gdUrl
              });
            }
          }
          
          // Provide download/player link as external player fallback
          if (item.download && item.download[episodeKey]) {
            streams.push({
              name: `Crtanko S${season}E${episode} (External Link)`,
              externalUrl: item.download[episodeKey]
            });
          }
          
          // Always offer the main web page as fallback
          streams.push({
            name: "Crtanko Web Page (Browser)",
            externalUrl: item.url
          });
        }
      }
    }
  } catch (err) {
    console.error(`[Server] Error processing stream for ${id}:`, err.message);
  }
  
  res.json({ streams });
});

export default app;
