// Join through the lobby, /quit from the console, and check the page returns to
// the lobby instead of a stopped canvas. usage: node quit.mjs <url> [name]
import { chromium } from 'playwright';
const [url, name = 'Quitter'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
page.on('pageerror', (e) => log('pageerror: ' + e.message));
await page.goto(url);
await page.fill('#name', name);
await page.click('#play');
await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 300000 });
await page.waitForTimeout(3000);
await page.keyboard.press('Shift+Escape'); await page.waitForTimeout(500);
await page.keyboard.type('/quit'); await page.keyboard.press('Enter');
try {
  await page.waitForFunction(() => document.getElementById('lobby')?.style.display !== 'none' && document.getElementById('name'), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  log('back at the lobby');
} catch {
  log('FAIL: still on the game screen');
}
await page.screenshot({ path: '/runs/quit.png' });
await browser.close();
