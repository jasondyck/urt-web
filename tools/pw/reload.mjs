// Refreshing the tab must not leave a ghost player behind: join, reload, join
// again, then count this name in the server's player list.
// usage: node reload.mjs <url> [name]
import { chromium } from 'playwright';
const [url, name = 'Reloader'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
page.on('pageerror', (e) => log('pageerror: ' + e.message));
const players = async () => (await (await page.request.get(new URL('status.json', url).href)).json()).players.filter((p) => p.name.startsWith(name));
for (const visit of [1, 2]) {
  if (visit === 1) await page.goto(url); else await page.reload();
  await page.fill('#name', name);
  await page.click('#play');
  await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 300000 });
  await page.waitForTimeout(5000);
  log(`visit ${visit}: qport ${await page.evaluate(() => sessionStorage.getItem('urt-web.qport'))}, players named ${name}*: ${JSON.stringify((await players()).map((p) => p.name))}`);
}
const n = (await players()).length;
log(n === 1 ? 'PASS: one player after reload' : `FAIL: ${n} players after reload`);
await browser.close();
