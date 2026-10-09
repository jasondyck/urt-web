// Two browser players join the same server; each auto-joins a team, then screenshots.
// usage: node mp.mjs <base-url-with-args-but-no-name> [seconds] [outdir]
import { chromium } from 'playwright';
const [base, seconds = '60', out = '/runs'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const t0 = Date.now();
const players = [];
for (const name of ['Alice', 'Bob']) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { const t = m.text(); if (/connected|entered|joined|ERROR|killed|gateway/i.test(t)) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}: ${t}`); });
  page.on('pageerror', (e) => console.log(`${name} pageerror: ${e.message}`));
  await page.goto(`${base}%20%2bset%20name%20${name}`);
  players.push({ name, page });
}
await players[0].page.waitForTimeout(35000);
for (const p of players) { await p.page.mouse.click(480, 300); await p.page.keyboard.press('1'); }
await players[0].page.waitForTimeout(Number(seconds) * 1000 - 35000);
for (const p of players) await p.page.screenshot({ path: `${out}/mp-${p.name}.png` });
await browser.close();
