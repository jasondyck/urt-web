// End-to-end lobby test: visit, enter name, Play, wait for the game; then reload and
// play again to check the IndexedDB cache. usage: node lobby.mjs <url> [name]
import { chromium } from 'playwright';
const [url, name = 'Tester'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
let t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
page.on('console', (m) => { const t = m.text(); if (/Welcome to Urban|entered the game|ERROR|error|gateway/i.test(t)) log(t); });
page.on('pageerror', (e) => log('pageerror: ' + e.message));
for (const visit of ['first', 'second']) {
  t0 = Date.now();
  await page.goto(url);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/runs/lobby-${visit}.png` });
  log(`${visit} visit: server card = ${(await page.textContent('#server')).replace(/\s+/g, ' ').trim()}`);
  await page.fill('#name', name);
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('game').style.display === 'block', null, { timeout: 300000 });
  log(`${visit} visit: engine starting`);
  await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 120000 });
  log(`${visit} visit: in game`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/runs/lobby-${visit}-ingame.png` });
}
log('idb usage MB ' + await page.evaluate(async () => Math.round((await navigator.storage.estimate()).usage / 1e6)));
await browser.close();
