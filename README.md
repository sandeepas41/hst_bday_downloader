# HST Birthday Image Downloader

Download all 366 Hubble Space Telescope birthday images from NASA, organized by date with rich metadata.

## What is this?

NASA's "What Did Hubble See on Your Birthday?" feature shows a Hubble image for each day of the year. This tool downloads all images in all available formats, along with detailed metadata for each.

Source: https://imagine.gsfc.nasa.gov/hst_bday/

## Output Structure

```
dumps/
  01-01/
    metadata.json       # All extracted data
    video-content.json  # Enriched content for video creation
    full.jpg            # Highest resolution (~3000x2400)
    image.pdf           # PDF version
    thumb_200.jpg       # 200x200
    thumb_400.jpg       # ~400px width
    thumb_1000.jpg      # ~1000px width
  01-02/
    ...
  12-31/
```

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browser
npm run install-browser
# or: npx playwright install chromium
```

## Usage

### 1. Download Images

```bash
node download.js
```

This will:
- Read `data.csv` (366 entries, one per day)
- Navigate to each URL (handles redirects from hubblesite.org to science.nasa.gov)
- Download all available formats (PDF + all JPG sizes)
- Extract metadata (object name, constellation, distance, instrument, etc.)
- Save everything to `dumps/MM-DD/` folders

**Features:**
- Resume capability: automatically skips already processed folders
- Retry logic: retries failed downloads up to 3 times
- Rate limiting: 800ms delay between pages

### 2. Enrich Metadata (Optional)

```bash
node enrich-metadata.js
```

This will:
- Visit each folder's final URL
- Extract full descriptions and paragraphs
- Create `video-content.json` with structured content for video/social media creation

**Features:**
- Resume capability: skips folders with existing `video-content.json`
- Rate limiting: 500ms delay between requests

## Data Files

### metadata.json

Contains raw extracted data:

```json
{
  "date": "January 1 2019",
  "folder": "01-01",
  "originalUrl": "https://hubblesite.org/...",
  "finalUrl": "https://science.nasa.gov/...",
  "csvName": "Galaxy Leo IV",
  "csvCaption": "...",
  "pageTitle": "Ultra-Faint Dwarf Galaxy Leo IV",
  "objectName": "Leo IV",
  "objectDescription": "Ultra-Faint Dwarf Galaxy",
  "constellation": "Leo",
  "distance": "500,000 light-years",
  "instrument": "HST>ACS/WFC",
  "exposureDates": "January 1, 2012",
  "filters": "F606W (V) and F814W (I)",
  "releaseDate": "July 10, 2012",
  "credit": "NASA, ESA, and T. Brown (STScI)",
  "raPosition": "11h 32m 56.99s",
  "decPosition": "00° 31' 59.98\"",
  "downloads": [...]
}
```

### video-content.json

Structured content optimized for video/social media creation:

```json
{
  "title": "Ultra-Faint Dwarf Galaxy Leo IV",
  "shortCaption": "...",
  "fullDescription": "...",
  "paragraphs": ["...", "..."],
  "quickFacts": {
    "objectName": "Leo IV",
    "objectType": "Ultra-Faint Dwarf Galaxy",
    "constellation": "Leo",
    "distance": "500,000 light-years",
    "instrument": "HST>ACS/WFC",
    "releaseDate": "July 10, 2012"
  },
  "tags": ["Galaxies", "Dwarf Galaxies"],
  "technical": {
    "filters": "F606W (V) and F814W (I)",
    "exposureDates": "January 1, 2012"
  },
  "credit": "NASA, ESA, and T. Brown (STScI)",
  "images": {
    "fullResolution": "full.jpg",
    "thumbnail": "thumb_1000.jpg"
  }
}
```

## Estimated Storage

- ~6-7 MB per day
- ~2.5 GB total for all 366 days

## Dependencies

- `playwright` - Browser automation for handling redirects and dynamic content
- `csv-parse` - CSV parsing

## License

ISC
