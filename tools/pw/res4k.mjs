// Simulated 4K screen: check resolution options and measure fps for a choice.
import { chromium } from 'playwright';
const [url, choice] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, screen: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (/^MODE:/.test(m.text())) console.log(m.text()); });
await page.goto(url);
console.log('options:', await page.$$eval('#res option', (os) => os.map((o) => `${o.value}=${o.textContent}`).join(' | ')));
await page.fill('#name', 'Res'); await page.selectOption('#res', choice); await page.click('#play');
await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 120000 });
await page.waitForTimeout(3000);
const fps = await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 5000 ? requestAnimationFrame(f) : r(n / 5); }; requestAnimationFrame(f); }));
console.log(`choice ${choice}: canvas ${await page.$eval('#canvas', (c) => c.width + 'x' + c.height)}, ~${fps.toFixed(0)} fps`);
await browser.close();
