// Screenshot the lobby's join and host tabs, optionally joining the first listed game.
// usage: node lobbyshot.mjs <site-url> [outdir] [play-seconds]
import { chromium } from 'playwright';
const [site, out = '/runs', play = '0'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
page.on('console', (m) => { if (/urt|ERROR|connected|entered|error/i.test(m.text())) console.log(m.text()); });
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
await page.goto(site);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/lobby-join.png` });
if (await page.isVisible('#tabs')) {
  await page.click('[data-tab=host]');
  await page.screenshot({ path: `${out}/lobby-host.png` });
  await page.click('[data-tab=join]');
}
if (+play) {
  await page.fill('#name', 'Dave');
  await page.click('#play');
  await page.waitForTimeout(+play * 1000);
  await page.screenshot({ path: `${out}/lobby-played.png` });
}
await browser.close();
