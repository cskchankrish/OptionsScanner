# OptionsScanner — Live Dashboard

Live options swing trading scanner that auto-fetches data from a published Google Sheet every 15 minutes.

## What this is

A React app built with Vite that:
- Fetches your Google Sheets data (published as CSV)
- Scores 200+ F&O stocks based on Inside Day, Inside Value, Confluence Pivots, and Compression Ratio signals
- Auto-refreshes every 15 minutes
- Has light/dark theme toggle
- Works on mobile and desktop

## Deploy in 10 minutes (FREE forever)

### Option 1 — Vercel (recommended, easiest)

1. Go to https://vercel.com and sign up with GitHub (free)
2. Create a new GitHub repository called `options-scanner`
3. Upload all the files from this folder to that repo (drag & drop on github.com works)
4. In Vercel, click **"Add New Project"** → import your repo
5. Vercel auto-detects Vite — just click **"Deploy"**
6. Done. You'll get a URL like `options-scanner-yourname.vercel.app`

### Option 2 — Netlify

1. Go to https://netlify.com and sign up
2. Drag & drop the entire folder onto the Netlify dashboard
3. Or connect a GitHub repo (same flow as Vercel)
4. Done. You get a URL like `options-scanner-yourname.netlify.app`

### Option 3 — Cloudflare Pages

1. Go to https://pages.cloudflare.com
2. Connect GitHub → import repo
3. Build command: `npm run build`, Build output: `dist`
4. Done. URL like `options-scanner.pages.dev`

## Run locally first (optional, to test before deploying)

```bash
npm install
npm run dev
```

Open http://localhost:5173 — should load with live data.

## Files

- `src/App.jsx` — the entire dashboard (single file, ~730 lines)
- `src/main.jsx` — React entry point
- `index.html` — HTML shell
- `vite.config.js` — Vite config
- `package.json` — dependencies

## Updating the data source

The Google Sheets CSV URL is hard-coded at the top of `src/App.jsx`:

```js
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/.../pub?output=csv";
```

To use a different sheet:
1. Edit that line
2. Commit & push to GitHub — Vercel/Netlify auto-redeploys

## Sharing with friends

Just send them the deployed URL. Works on any device, no login needed, always shows the latest data from your sheet.

## Customization

- **Refresh interval** — change `REFRESH_MS` in `App.jsx` (currently 15 minutes)
- **Page size** — change `PAGE_SIZE` (currently 40 cards per page)
- **Theme colors** — edit `THEMES` object at the top of `App.jsx`

## Why not host inside Claude artifacts?

Claude artifacts run in a sandboxed iframe that blocks `fetch()` to external domains for security. That's why the dashboard couldn't pull live data from Google Sheets directly inside Claude. Deploying to Vercel/Netlify removes that restriction completely — it's just a normal web app.
