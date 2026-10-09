// Two players join, pick teams, then move/jump/fire/reload for a while. Reports VM errors.
// usage: node play.mjs <url-with-connect-args> [seconds]
import { chromium } from 'playwright';
const [base, seconds = '60'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const players = [];
for (const [name, team] of [['Alice', '2'], ['Bob', '3']]) {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();
  page.on('console', (m) => { const t = m.text(); if (/ERROR|VM |vm_wasm|error|killed|was |entered|Aborted/i.test(t)) log(`${name}: ${t}`); });
  page.on('pageerror', (e) => log(`${name} pageerror: ${e.message}`));
  await page.goto(`${base}%20%2bset%20name%20${name}`);
  players.push({ name, team, page });
}
await players[0].page.waitForTimeout(25000);
for (const p of players) { await p.page.mouse.click(480, 300); await p.page.keyboard.press(p.team); }
await players[0].page.waitForTimeout(8000);
// close any weapon menu, then play
for (const p of players) await p.page.keyboard.press('Escape');
const end = Date.now() + Number(seconds) * 1000;
let step = 0;
while (Date.now() < end) {
  for (const p of players) {
    const k = p.page.keyboard;
    const moves = ['w', 'a', 's', 'd'];
    await k.down(moves[step % 4]);
    await p.page.mouse.move(480 + ((step * 37) % 200) - 100, 300);
    await p.page.mouse.down(); await p.page.waitForTimeout(150); await p.page.mouse.up();
    if (step % 5 === 0) await k.press('Space');
    if (step % 9 === 0) await k.press('r');
    await k.up(moves[step % 4]);
  }
  step++;
}
for (const p of players) await p.page.screenshot({ path: `/runs/play-${p.name}.png` });
log(`done after ${step} steps`);
await browser.close();
