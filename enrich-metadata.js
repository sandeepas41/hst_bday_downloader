import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const DUMPS_DIR = './dumps';
const DELAY_MS = 500;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract video-friendly content from page
const extractVideoContent = async (page) => {
  return await page.evaluate(() => {
    // Get all description paragraphs
    const paragraphs = Array.from(document.querySelectorAll('article p'))
      .map(p => p.textContent.trim())
      .filter(text => text.length > 50); // Filter out short texts like "1 min read"

    // Get the title
    const title = document.querySelector('h1')?.textContent?.trim();

    // Get related terms/tags
    const relatedTerms = Array.from(document.querySelectorAll('a'))
      .filter(a => a.href.includes('/category/') || a.href.includes('/universe/'))
      .map(a => a.textContent.trim())
      .filter((v, i, a) => a.indexOf(v) === i); // unique

    // Get science release title if exists
    const scienceRelease = (() => {
      const items = document.querySelectorAll('li');
      for (const item of items) {
        if (item.textContent.includes('Science Release')) {
          const text = item.textContent.replace('Science Release', '').replace('Read the release', '').trim();
          return text || null;
        }
      }
      return null;
    })();

    // Get color info if available
    const colorInfo = (() => {
      const colorSection = Array.from(document.querySelectorAll('div, p'))
        .find(el => el.textContent.includes('Color Info') || el.textContent.includes('assigned colors'));
      if (colorSection) {
        const text = colorSection.textContent;
        const match = text.match(/assigned colors are[:\s]*(.*)/i);
        return match ? match[1].trim() : null;
      }
      return null;
    })();

    // Get main image URL
    const mainImage = document.querySelector('article img[src*="hubble"]')?.src ||
                      document.querySelector('article img')?.src;

    return {
      title,
      fullDescription: paragraphs.join('\n\n'),
      descriptionParagraphs: paragraphs,
      relatedTerms,
      scienceRelease,
      colorInfo,
      mainImageUrl: mainImage,
    };
  });
};

// Process a single folder
const processFolder = async (page, folderPath, index, total) => {
  const folderName = path.basename(folderPath);
  const metadataPath = path.join(folderPath, 'metadata.json');
  const enrichedPath = path.join(folderPath, 'video-content.json');

  const progress = ((index + 1) / total * 100).toFixed(1);
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] [${index + 1}/${total}] (${progress}%) ${folderName}`);

  // Check if already enriched
  try {
    await fs.access(enrichedPath);
    console.log(`  ⏭  Skipped (already enriched)`);
    return { success: true, skipped: true };
  } catch {
    // Continue processing
  }

  // Read existing metadata
  let metadata;
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    metadata = JSON.parse(content);
  } catch (error) {
    console.log(`  ❌ Error: No metadata.json found`);
    return { success: false, error: 'No metadata' };
  }

  // Check if we have a finalUrl
  if (!metadata.finalUrl) {
    console.log(`  ❌ Error: No finalUrl in metadata`);
    return { success: false, error: 'No finalUrl' };
  }

  try {
    const shortUrl = metadata.finalUrl.replace('https://science.nasa.gov/', '');
    console.log(`  🌐 Fetching: ${shortUrl}`);
    const startTime = Date.now();
    await page.goto(metadata.finalUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await delay(300);

    // Extract video content
    const videoContent = await extractVideoContent(page);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Create video-friendly JSON
    const enrichedData = {
      // Basic info
      date: metadata.date,
      folder: folderName,

      // For video title/hook
      title: videoContent.title || metadata.pageTitle || metadata.csvName,
      shortCaption: metadata.csvCaption,

      // Full story for narration
      fullDescription: videoContent.fullDescription,
      paragraphs: videoContent.descriptionParagraphs,

      // Quick facts for on-screen text
      quickFacts: {
        objectName: metadata.objectName,
        objectType: metadata.objectDescription,
        constellation: metadata.constellation,
        distance: metadata.distance,
        instrument: metadata.instrument,
        releaseDate: metadata.releaseDate,
        yearCaptured: metadata.csvYear,
      },

      // Tags for hashtags
      tags: videoContent.relatedTerms,
      scienceRelease: videoContent.scienceRelease,

      // Technical details (for captions)
      technical: {
        filters: metadata.filters,
        exposureDates: metadata.exposureDates,
        colorInfo: videoContent.colorInfo,
      },

      // Credits
      credit: metadata.credit,

      // Image paths
      images: {
        fullResolution: 'full.jpg',
        thumbnail: 'thumb_1000.jpg',
        webUrl: videoContent.mainImageUrl,
      },

      // URLs
      urls: {
        original: metadata.originalUrl,
        final: metadata.finalUrl,
      },

      // Metadata
      enrichedAt: new Date().toISOString(),
    };

    // Save enriched data
    await fs.writeFile(enrichedPath, JSON.stringify(enrichedData, null, 2));

    const titleShort = (enrichedData.title || '').substring(0, 40);
    console.log(`  ✅ Done in ${elapsed}s | "${titleShort}..." | ${enrichedData.paragraphs.length} paragraphs`);

    return { success: true, skipped: false };
  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
};

// Main function
const main = async () => {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════╗');
  console.log('║   HST Video Content Enricher         ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Get all folders
  const entries = await fs.readdir(DUMPS_DIR, { withFileTypes: true });
  const folders = entries
    .filter(e => e.isDirectory())
    .map(e => path.join(DUMPS_DIR, e.name))
    .sort();

  console.log(`📁 Found ${folders.length} folders to process`);
  console.log(`⏱  Delay: ${DELAY_MS}ms between requests\n`);

  // Launch browser
  console.log('🚀 Launching browser...\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  const stats = { processed: 0, skipped: 0, failed: 0 };

  try {
    for (let i = 0; i < folders.length; i++) {
      const result = await processFolder(page, folders[i], i, folders.length);

      if (result.success) {
        if (result.skipped) stats.skipped++;
        else stats.processed++;
      } else {
        stats.failed++;
      }

      if (!result.skipped) {
        await delay(DELAY_MS);
      }
    }
  } finally {
    await browser.close();
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Enrichment Complete!               ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  ✅ Processed: ${stats.processed}`);
  console.log(`  ⏭  Skipped:   ${stats.skipped}`);
  console.log(`  ❌ Failed:    ${stats.failed}`);
  console.log(`  ⏱  Total time: ${totalTime}s`);
};

main().catch(console.error);
