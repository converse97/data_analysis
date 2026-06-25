const { chromium } = require('playwright');
const readline = require('readline');

const STORAGE_STATE_PATH = 'xhs-state.json';
const XHS_HOME_URL = 'https://www.xiaohongshu.com';

function waitForEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`Opening ${XHS_HOME_URL}`);
    await page.goto(XHS_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    console.log('Please complete login manually in the browser window.');
    await waitForEnter('After login is complete, press Enter here to save xhs-state.json...');

    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Saved login state to ${STORAGE_STATE_PATH}`);
  } catch (error) {
    console.error('Failed to save Xiaohongshu login state.');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
