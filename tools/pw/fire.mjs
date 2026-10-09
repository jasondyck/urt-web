// Can a player shoot? Two players join through the lobby on opposite teams so a
// Team Survivor round starts, then the first one fires with the mouse and with
// +attack from the console, screenshotting between so the ammo can be compared.
// usage: node fire.mjs <url> [name] [solo]   (solo: no opponent, for FFA modes)
import { chromium } from 'playwright';
const [url, name = 'Shooter', solo] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

async function join(who, team) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('console', (m) => { const t = m.text(); if (/entered|ERROR|error|killed|round|Welcome/i.test(t)) log(`${who}: ${t}`); });
  page.on('pageerror', (e) => log(`${who} pageerror: ${e.message}`));
  await page.goto(url);
  await page.fill('#name', who);
  await page.click('#play');
  await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 300000 });
  await page.waitForTimeout(5000);
  await page.mouse.click(640, 400);
  await page.keyboard.press(team);                    // team menu: 2 red, 3 blue
  await page.waitForTimeout(6000);
  await page.keyboard.press('Escape');                // close the gear menu
  return page;
}

const page = await join(name, '2');
if (!solo) await join(name + 'Foe', '3');
await page.waitForTimeout(Number(process.env.SETTLE || 8000));
await page.screenshot({ path: '/runs/fire-0-ready.png' });
await page.mouse.down(); await page.waitForTimeout(1500); await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: '/runs/fire-1-mouse.png' });
await page.keyboard.press('Shift+Escape'); await page.waitForTimeout(500);
await page.keyboard.type('/+attack'); await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await page.keyboard.type('/-attack'); await page.keyboard.press('Enter');
await page.keyboard.press('Shift+Escape'); await page.waitForTimeout(500);
await page.screenshot({ path: '/runs/fire-2-console.png' });
log('done');
await browser.close();
