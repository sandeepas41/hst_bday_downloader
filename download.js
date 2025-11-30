import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

const DUMPS_DIR = './dumps';
const DELAY_MS = 800; // 0.8 seconds between pages
const MAX_RETRIES = 3;

// Month name to number mapping
const MONTHS = {
  'January': '01', 'February': '02', 'March': '03', 'April': '04',
  'May': '05', 'June': '06', 'July': '07', 'August': '08',
  'September': '09', 'October': '10', 'November': '11', 'December': '12'
};

// Parse date like "January 1 2019" to folder name "01-01"
const parseDateToFolder = (dateStr) => {
  const parts = dateStr.split(' ');
  const month = MONTHS[parts[0]];
  const day = parts[1].padStart(2, '0');
  return `${month}-${day}`;
};

// Parse CSV file
const parseCSV = async () => {
  const csvContent = await fs.readFile('./data.csv', 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  });
  return records;
};

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Format bytes to human readable
const formatBytes = (bytes) => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
};

// Download file with retry
const downloadFile = async (url, destPath, retries = MAX_RETRIES) => {
  const filename = path.basename(destPath);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const startTime = Date.now();
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(destPath, buffer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`      ✓ ${filename} (${formatBytes(buffer.length)}) in ${elapsed}s`);
      return true;
    } catch (error) {
      console.log(`      ✗ ${filename} attempt ${attempt}/${retries}: ${error.message}`);
      if (attempt === retries) {
        return false;
      }
      await delay(500 * attempt);
    }
  }
  return false;
};

// Extract metadata from page
const extractMetadata = async (page) => {
  return await page.evaluate(() => {
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : null;
    };

    const getMetaField = (fieldName) => {
      const items = document.querySelectorAll('li');
      for (const item of items) {
        const label = item.querySelector('[cursor="pointer"]')?.textContent?.trim();
        if (label && label.toLowerCase().includes(fieldName.toLowerCase())) {
          const siblings = item.querySelectorAll('div');
          if (siblings.length > 1) {
            return siblings[siblings.length - 1].textContent.trim();
          }
        }
      }
      return null;
    };

    // Extract downloads - find the Downloads heading and get adjacent list
    const downloads = [];
    const h3Elements = document.querySelectorAll('h3');
    let downloadHeading = null;

    for (const h3 of h3Elements) {
      if (h3.textContent.trim() === 'Downloads') {
        downloadHeading = h3;
        break;
      }
    }

    if (downloadHeading) {
      // Find the list after the Downloads heading
      let nextEl = downloadHeading.nextElementSibling;
      while (nextEl && nextEl.tagName !== 'UL' && nextEl.tagName !== 'OL') {
        nextEl = nextEl.nextElementSibling;
      }

      if (nextEl) {
        const items = nextEl.querySelectorAll('li');
        items.forEach(item => {
          const link = item.querySelector('a');
          if (link && link.href) {
            const url = link.href;
            const textContent = item.textContent;

            // Parse format info
            const isPdf = textContent.toLowerCase().includes('pdf');
            const sizeMatch = textContent.match(/\(([^)]+)\)/);
            const resMatch = textContent.match(/(\d+)\s*[x×]\s*(\d+)/);

            downloads.push({
              url,
              type: isPdf ? 'pdf' : 'jpg',
              size: sizeMatch ? sizeMatch[1] : null,
              resolution: resMatch ? `${resMatch[1]}x${resMatch[2]}` : null,
            });
          }
        });
      }
    }

    // Get various metadata fields
    const listItems = document.querySelectorAll('li');
    const metadata = {};

    listItems.forEach(item => {
      const divs = item.querySelectorAll('div');
      if (divs.length >= 2) {
        const label = divs[0]?.textContent?.trim()?.toLowerCase();
        const value = divs[divs.length - 1]?.textContent?.trim();

        if (label && value && label !== value.toLowerCase()) {
          if (label.includes('object name')) metadata.objectName = value;
          else if (label.includes('object description')) metadata.objectDescription = value;
          else if (label.includes('release date')) metadata.releaseDate = value;
          else if (label.includes('r.a. position')) metadata.raPosition = value;
          else if (label.includes('dec. position')) metadata.decPosition = value;
          else if (label.includes('constellation')) metadata.constellation = value;
          else if (label.includes('distance')) metadata.distance = value;
          else if (label.includes('instrument')) metadata.instrument = value;
          else if (label.includes('exposure date')) metadata.exposureDates = value;
          else if (label.includes('filter')) metadata.filters = value;
          else if (label.includes('credit')) metadata.credit = value;
        }
      }
    });

    // Get page title/description
    const title = document.querySelector('h1')?.textContent?.trim();
    const description = document.querySelector('article p')?.textContent?.trim();

    return {
      pageTitle: title,
      pageDescription: description,
      ...metadata,
      downloads,
    };
  });
};

// Process a single row
const processRow = async (page, row, index, total) => {
  const folder = parseDateToFolder(row.Date);
  const folderPath = path.join(DUMPS_DIR, folder);
  const metadataPath = path.join(folderPath, 'metadata.json');

  const progress = ((index + 1) / total * 100).toFixed(1);
  console.log(`\n[${index + 1}/${total}] (${progress}%) ${row.Date} -> ${folder}`);

  // Check if already processed (resume capability) - verify images exist, not just metadata
  try {
    await fs.access(metadataPath);
    // Also check if at least one image file exists
    const files = await fs.readdir(folderPath);
    const hasImages = files.some(f => f.endsWith('.jpg') || f.endsWith('.pdf'));
    if (hasImages) {
      console.log(`  Skipping - already processed (${files.length - 1} files)`);
      return { success: true, skipped: true };
    }
    // Has metadata but no images - needs reprocessing
    console.log(`  Reprocessing - metadata exists but no images`);
  } catch {
    // Folder doesn't exist or no metadata, continue processing
  }

  try {
    // Navigate to URL
    console.log(`  Navigating to: ${row.URL}`);
    await page.goto(row.URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait a bit for dynamic content
    await delay(500);

    const finalUrl = page.url();
    console.log(`  Final URL: ${finalUrl}`);

    // Extract metadata
    let pageData = await extractMetadata(page);

    // If no downloads found, check for "Download Image" link (news pages)
    if (pageData.downloads.length === 0) {
      const downloadImageLink = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/asset/"]');
        return link ? link.href : null;
      });

      if (downloadImageLink) {
        console.log(`    ⤴ Following asset link: ${downloadImageLink}`);
        await page.goto(downloadImageLink, { waitUntil: 'networkidle', timeout: 60000 });
        await delay(500);
        pageData = await extractMetadata(page);
      }
    }

    // Create folder
    await fs.mkdir(folderPath, { recursive: true });

    // Build metadata object
    const metadata = {
      date: row.Date,
      folder,
      originalUrl: row.URL,
      finalUrl,
      csvName: row.Name,
      csvCaption: row.Caption,
      csvYear: row.Year,
      csvImage: row.Image,
      ...pageData,
      downloadedAt: new Date().toISOString(),
    };

    console.log(`    📥 Downloading ${pageData.downloads.length} files...`);

    // Download files
    let downloadedCount = 0;
    for (const download of pageData.downloads) {
      let filename;
      if (download.type === 'pdf') {
        filename = 'image.pdf';
      } else if (download.resolution) {
        const [width] = download.resolution.split('x');
        if (parseInt(width) >= 2000) {
          filename = 'full.jpg';
        } else if (parseInt(width) >= 800) {
          filename = 'thumb_1000.jpg';
        } else if (parseInt(width) >= 300) {
          filename = 'thumb_400.jpg';
        } else {
          filename = 'thumb_200.jpg';
        }
      } else {
        filename = `image_${downloadedCount}.jpg`;
      }

      const destPath = path.join(folderPath, filename);
      const success = await downloadFile(download.url, destPath);
      if (success) downloadedCount++;
    }

    console.log(`    ✅ Complete: ${downloadedCount}/${pageData.downloads.length} files`);

    // Save metadata
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`  Saved metadata.json`);

    return { success: true, skipped: false };
  } catch (error) {
    console.error(`  Error processing: ${error.message}`);
    return { success: false, error: error.message };
  }
};

// Main function
const main = async () => {
  console.log('HST Birthday Image Downloader');
  console.log('=============================\n');

  // Parse CSV
  console.log('Reading data.csv...');
  const records = await parseCSV();
  console.log(`Found ${records.length} entries\n`);

  // Create dumps directory
  await fs.mkdir(DUMPS_DIR, { recursive: true });

  // Launch browser
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Process stats
  const stats = { processed: 0, skipped: 0, failed: 0 };

  try {
    for (let i = 0; i < records.length; i++) {
      const result = await processRow(page, records[i], i, records.length);

      if (result.success) {
        if (result.skipped) {
          stats.skipped++;
        } else {
          stats.processed++;
        }
      } else {
        stats.failed++;
      }

      // Delay between requests (except for skipped)
      if (!result.skipped && i < records.length - 1) {
        await delay(DELAY_MS);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=============================');
  console.log('Download Complete!');
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Failed: ${stats.failed}`);
};

main().catch(console.error);
