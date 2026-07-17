# Crtanko Stremio Addon

Stremio i Wuplay addon koji omogućuje pretraživanje, pregledavanje i izravnu reprodukciju sinkroniziranih crtanih filmova i serija s web stranice [Crtanko](https://www.crtanko.xyz/).

## Značajke

- **Direktna reprodukcija u playeru**: TV serije se učitavaju izravno s Google Drivea, zaobilazeći virusna upozorenja i reklame, te se reproduciraju unutar Stremio playera.
- **Brza pretraga i katalog**: Svi crtići se spremaju u lokalnu JSON bazu kako bi pretraga i katalozi radili trenutno.
- **Podrška za vanjske playere**: Za filmove koji se ne mogu direktno učitati unutar Stremio playera (zbog Cloudflare zaštite na nekim serverima), addon nudi "Web Player (Browser)" i "External Player" opcije.

---

## Instalacija i Pokretanje (Lokalno)

Kako bi addon radio najpouzdanije (neki streamovi provjeravaju IP adresu i dopuštaju reprodukciju samo ako poslužitelj i player imaju istu IP adresu), preporučuje se pokretanje addona lokalno na računalu.

### Korak 1: Instalacija Node.js
Uvjerite se da imate instaliran [Node.js](https://nodejs.org/).

### Korak 2: Instalacija paketa
Otvorite terminal (PowerShell ili Command Prompt) u mapi projekta i pokrenite:
```bash
npm install
```

### Korak 3: Pokretanje Scrapera (Izgradnja baze podataka)
Kako bi se baza crtanih filmova popunila, pokrenite scraper:
```bash
npm run scrape
```
*Napomena: Prvo pokretanje može potrajati oko 1-2 minute jer scraper preuzima podatke o svim crtićima s portala Crtanko. Svako sljedeće pokretanje bit će trenutačno jer scraper dodaje samo nove crtiće.*

### Korak 4: Pokretanje poslužitelja
Pokrenite lokalni poslužitelj pomoću naredbe:
```bash
npm start
```
Poslužitelj će se pokrenuti na portu `3000`.

### Korak 5: Instalacija u Stremio
1. Otvorite aplikaciju **Stremio**.
2. Idite na odjeljak **Addons** (Proširenja).
3. U tražilicu dodataka zalijepite sljedeću adresu:
   ```
   http://localhost:3000/manifest.json
   ```
4. Kliknite **Install** (Instaliraj).

Sada ćete u Stremio katalogu vidjeti nove kategorije **Crtanko Filmovi** i **Crtanko Serije**, a pretraga sinkroniziranih crtića će raditi automatski!

---

## Deploy na Vercel (Cloud)

Projekt je konfiguriran za rad na **Vercel Serverless** platformi.

### Kako deployati:

1. **Učitajte bazu lokalno**:
   Prije nego što prenesete projekt na GitHub, pokrenite scraper barem jednom lokalno kako bi se stvorila datoteka `crtanko_db.json` s kompletnom bazom crtića:
   ```bash
   npm run scrape
   ```
2. **Učitajte na GitHub**:
   Kreirajte repozitorij na GitHubu i učitajte cijeli projekt, **uključujući** datoteku `crtanko_db.json`.
3. **Povežite s Vercelom**:
   - Prijavite se na [Vercel](https://vercel.com/).
   - Kliknite na **Add New** -> **Project**.
   - Importajte vaš GitHub repozitorij.
   - Vercel će automatski prepoznati `vercel.json` i konfigurirati Express aplikaciju kao serverless funkciju.
   - Kliknite **Deploy**.
4. **Instalacija u Stremio**:
   Nakon uspješnog deploya, dobit ćete Vercel domenu (npr. `stremio-crtanko.vercel.app`).
   Zalijepite tu domenu u Stremio Addons tražilicu u ovom obliku:
   ```
   https://vas-projekt.vercel.app/manifest.json
   ```

