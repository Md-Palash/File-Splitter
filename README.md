# File Spliter

Split a big zip, a folder or a set of images into smaller parts of the size you choose, then rejoin them. Everything runs in the browser. Nothing is uploaded.

## Features
- Add zips, loose files or whole folders (drag and drop works anywhere on the page)
- Choose the largest size per part (KB, MB or GB) and split by size, file count, type or folder
- Files bigger than the limit are cut into `.part001`, `.part002` pieces and rebuilt on rejoin
- Optional image conversion and resize (WebP, JPG, PNG) before splitting
- Rejoin: drop in the parts, spot missing ones, verify CRC32 checksums, merge into one zip
- Three scenes: Dawn Mist, Crimson Dusk, Moonlit Night (canvas, no libraries)

## Deploy with GitHub and Vercel
1. Create a GitHub repository and push this folder to it.
2. In Vercel choose **Add New → Project**, import the repository.
3. Leave **Framework Preset** as *Other*. There is no build command and no output directory (the site is static).
4. Press **Deploy**.

After you have your domain, replace the relative `/` and `/og-image.png` URLs in `index.html` (`canonical`, `og:image`, `twitter:image`) with absolute ones, for example `https://your-domain.com/og-image.png`. Social sites need absolute image URLs.

## Local use
```
npm start      # serves the folder
npm test       # round-trip test of the zip engine (Node 20+)
```

## Notes
- Sizes use decimal units (1 MB = 1,000,000 bytes) so parts stay safely under a limit.
- Zip64 sources are read. Output parts are limited to 4 GB and 65,535 files each.
- The page loads fonts from Google Fonts. Remove that link to run fully offline (system fonts are used instead).
- `vercel.json` sets a Content-Security-Policy and other security headers. Scripts are inline in `index.html`, so `'unsafe-inline'` is allowed for scripts and styles.
