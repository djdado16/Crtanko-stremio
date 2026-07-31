process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { readFileSync } from 'fs';

const JF_BASE = 'https://nl5953.dediseedbox.com:48718';
const API_KEY = 'cbb97ebd740a48b5b127cad73b029667';
const jfHeaders = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

const db = JSON.parse(readFileSync('crtanko_db.json', 'utf8'));
const lookup = JSON.parse(readFileSync('jellyfin_lookup.json', 'utf8'));

// Check breakdown: which DB items are in Jellyfin, by their URL type
const stats = {
  filmativa: { total: 0, inJf: 0 },
  byse: { total: 0, inJf: 0 },
  roda: { total: 0, inJf: 0 },
  filemoon: { total: 0, inJf: 0 },
  other: { total: 0, inJf: 0 }
};

for (const item of Object.values(db)) {
  const allUrls = [
    item.apiData?.videolink, item.apiData?.videolinkhd,
    ...Object.values(item.streaming || {}),
    ...Object.values(item.download || {})
  ].filter(Boolean);
  
  let category = 'other';
  for (const url of allUrls) {
    if (url.includes('filmativa')) { category = 'filmativa'; break; }
    if (url.includes('roda.php')) { category = 'roda'; break; }
    if (url.includes('byse')) { category = 'byse'; break; }
    if (url.includes('filemoon')) { category = 'filemoon'; break; }
  }
  
  stats[category].total++;
  if (lookup[item.imdb_id]) stats[category].inJf++;
}

console.log('=== Jellyfin coverage by URL type ===');
for (const [cat, s] of Object.entries(stats)) {
  const pct = s.total > 0 ? Math.round(100*s.inJf/s.total) : 0;
  console.log(`${cat}: ${s.inJf}/${s.total} (${pct}%)`);
}

// Check if Jellyfin has series
console.log('\n=== Jellyfin series/episodes ===');
const seriesRes = await fetch(`${JF_BASE}/Items?api_key=${API_KEY}&Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds&Limit=20`, { headers: jfHeaders });
const seriesData = await seriesRes.json();
console.log(`Total series: ${seriesData.TotalRecordCount}`);
seriesData.Items?.slice(0,10).forEach(s => {
  console.log(`  ${s.Name} [imdb: ${s.ProviderIds?.Imdb ?? 'none'}]`);
});

// Check episodes for a known series
if (seriesData.Items?.length > 0) {
  const series = seriesData.Items[0];
  console.log(`\nEpisodes for: ${series.Name}`);
  const epRes = await fetch(`${JF_BASE}/Shows/${series.Id}/Episodes?api_key=${API_KEY}&Fields=IndexNumber,ParentIndexNumber,ProviderIds&Limit=5`, { headers: jfHeaders });
  if (epRes.ok) {
    const epData = await epRes.json();
    console.log(`Total episodes: ${epData.TotalRecordCount}`);
    epData.Items?.forEach(ep => {
      const streamUrl = `${JF_BASE}/Items/${ep.Id}/Download?api_key=${API_KEY}`;
      console.log(`  S${ep.ParentIndexNumber}E${ep.IndexNumber}: ${ep.Name}`);
      console.log(`    → ${streamUrl}`);
    });
  }
}

// Test the actual download URL playability with GET
console.log('\n=== Test actual Download URL with GET ===');
const kucniJfId = 'e39d01acd79cf15769a7ec0ea569f826'; // From roda.php
const dlUrl = `${JF_BASE}/Items/${kucniJfId}/Download?api_key=${API_KEY}`;
const r = await fetch(dlUrl, { headers: { 'User-Agent': 'ExoPlayer', 'Range': 'bytes=0-1023' } });
console.log(`Status: ${r.status}, Content-Type: ${r.headers.get('content-type')}, Length: ${r.headers.get('content-range')}`);

// Also test Video stream format (preferred by Stremio)
const streamUrl = `${JF_BASE}/Videos/${kucniJfId}/stream.mp4?api_key=${API_KEY}&Static=true`;
const sr = await fetch(streamUrl, { method: 'HEAD', headers: jfHeaders });
console.log(`Video stream: ${sr.status}, Type: ${sr.headers.get('content-type')}, Size: ${sr.headers.get('content-length')}`);
