require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const STORAGE_STATE_PATH = 'xhs-state.json';
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_SCROLLS = 20;
const SCROLL_DELAY_MS = 2_000;
const SAVE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInteger(value, fallback, optionName) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const keywordParts = [];
  const options = {
    limit: DEFAULT_LIMIT,
    maxScrolls: DEFAULT_MAX_SCROLLS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--limit') {
      options.limit = parsePositiveInteger(args[index + 1], DEFAULT_LIMIT, '--limit');
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(arg.slice('--limit='.length), DEFAULT_LIMIT, '--limit');
    } else if (arg === '--scrolls') {
      options.maxScrolls = parsePositiveInteger(args[index + 1], DEFAULT_MAX_SCROLLS, '--scrolls');
      index += 1;
    } else if (arg.startsWith('--scrolls=')) {
      options.maxScrolls = parsePositiveInteger(arg.slice('--scrolls='.length), DEFAULT_MAX_SCROLLS, '--scrolls');
    } else {
      keywordParts.push(arg);
    }
  }

  const keyword = keywordParts.join(' ').trim();
  if (!keyword) {
    throw new Error('Missing keyword. Usage: node crawl.js Patagonia --limit=100');
  }

  return {
    keyword,
    limit: options.limit,
    maxScrolls: options.maxScrolls,
  };
}

function buildSearchUrl(keyword) {
  const url = new URL('https://www.xiaohongshu.com/search_result');
  url.searchParams.set('keyword', keyword);
  return url.toString();
}

async function collectNotes(page, keyword) {
  return page.evaluate((currentKeyword) => {
    const toAbsoluteUrl = (value) => {
      try {
        return value ? new URL(value, window.location.origin).toString() : null;
      } catch (_error) {
        return null;
      }
    };

    const cleanText = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const findCardRoot = (anchor) => {
      return (
        anchor.closest('section') ||
        anchor.closest('div[class*="note"]') ||
        anchor.closest('div[class*="card"]') ||
        anchor.parentElement
      );
    };

    const anchors = Array.from(document.querySelectorAll('a[href]')).filter((anchor) => {
      const href = anchor.getAttribute('href') || '';
      return href.includes('/explore/') || href.includes('/discovery/item/');
    });

    const seenUrls = new Set();

    return anchors
      .map((anchor) => {
        const url = toAbsoluteUrl(anchor.getAttribute('href'));
        if (!url || seenUrls.has(url)) {
          return null;
        }
        seenUrls.add(url);

        const card = findCardRoot(anchor);
        const image = card ? card.querySelector('img') : anchor.querySelector('img');
        const titleElement = card
          ? card.querySelector('[title], .title, .note-title, span')
          : anchor.querySelector('[title], span');
        const authorElement = card
          ? card.querySelector('.author, .name, [class*="author"], [class*="user"]')
          : null;
        const likeElement = card
          ? card.querySelector('.like-wrapper, .count, [class*="like"], [class*="count"]')
          : null;

        const title = cleanText(
          (titleElement && (titleElement.getAttribute('title') || titleElement.textContent)) ||
            anchor.getAttribute('title') ||
            anchor.textContent
        );

        const coverUrl = image
          ? image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('src')
          : null;

        const authorName = authorElement ? cleanText(authorElement.textContent) : null;
        const likeCount = likeElement ? cleanText(likeElement.textContent) : null;

        return {
          keyword: currentKeyword,
          title,
          url,
          author_name: authorName,
          like_count: likeCount,
          cover_url: toAbsoluteUrl(coverUrl),
          raw_data: {
            card_text: card ? cleanText(card.textContent) : cleanText(anchor.textContent),
            href: anchor.getAttribute('href'),
            image_alt: image ? image.getAttribute('alt') : null,
          },
          crawled_at: new Date().toISOString(),
        };
      })
      .filter(Boolean);
  }, keyword);
}

async function collectUntilLimit(page, keyword, limit, maxScrolls) {
  let notes = await collectNotes(page, keyword);
  console.log(`Collected ${notes.length}/${limit} public note candidates before scrolling.`);

  for (let index = 0; index < maxScrolls && notes.length < limit; index += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(SCROLL_DELAY_MS);
    notes = await collectNotes(page, keyword);
    console.log(`Scroll ${index + 1}/${maxScrolls}: collected ${notes.length}/${limit} candidates.`);
  }

  return notes.slice(0, limit);
}

async function saveNote(supabase, note) {
  const { error } = await supabase
    .from('xhs_notes')
    .upsert(note, {
      onConflict: 'url',
      ignoreDuplicates: true,
    });

  if (error) {
    throw error;
  }
}

async function main() {
  let browser;

  try {
    const { keyword, limit, maxScrolls } = parseArgs();

    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      throw new Error(`Missing ${STORAGE_STATE_PATH}. Run npm run login first.`);
    }

    const supabaseUrl = requireEnv('SUPABASE_URL');
    const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const searchUrl = buildSearchUrl(keyword);

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const page = await context.newPage();

    console.log(`Opening search page: ${searchUrl}`);
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    console.log(`Target candidates: ${limit}; max scrolls: ${maxScrolls}; scroll delay: ${SCROLL_DELAY_MS}ms.`);

    await page.waitForTimeout(3_000);
    const notes = await collectUntilLimit(page, keyword, limit, maxScrolls);
    console.log(`Collected ${notes.length} public note candidates.`);

    let savedCount = 0;
    let failedCount = 0;

    for (const note of notes) {
      try {
        await saveNote(supabase, note);
        savedCount += 1;
        console.log(`Saved or skipped duplicate: ${note.url}`);
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to save note: ${note.url}`);
        console.error(error && error.message ? error.message : error);
      }

      await sleep(SAVE_DELAY_MS);
    }

    console.log(`Done. Processed: ${notes.length}, saved/skipped: ${savedCount}, failed: ${failedCount}`);
  } catch (error) {
    console.error('Crawler failed.');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
