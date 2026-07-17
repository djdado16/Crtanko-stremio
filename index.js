import app from './server.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[Server] Crtanko Stremio Addon running locally at http://localhost:${PORT}`);
  console.log(`[Server] Manifest URL: http://localhost:${PORT}/manifest.json`);
});
