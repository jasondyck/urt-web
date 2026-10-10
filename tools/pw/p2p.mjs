// Browser-hosted game: Alice hosts from the lobby, Bob joins through the invite
// link, Carol checks the public listing. Needs the site and signal/ running.
// usage: node p2p.mjs <site-url> [seconds] [outdir]
import { chromium } from 'playwright';
const [site, seconds = '60', out = '/runs'] = process.argv.slice(2);
const gpu = process.env.GPU === '1'
  ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...gpu, '--autoplay-policy=no-user-gesture-required'] });
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/connected|entered|joined|ERROR|urt:|p2p|timed out|Awaiting|challenge/i.test(t)) console.log(`${stamp()} ${name}: ${t}`);
  });
  page.on('pageerror', (e) => console.log(`${stamp()} ${name} pageerror: ${e.message}`));
  return page;
}

const alice = await player('Alice');
await alice.goto(site);
await alice.fill('#name', 'Alice');
await alice.click('[data-tab=host]');
await alice.selectOption('#map', process.env.MAP || 'ut4_abbey');
await alice.click('#play');
const invite = await new Promise((resolve) => alice.on('console', (m) => {
  const hit = m.text().match(/invite link (\S+)/);
  if (hit) resolve(hit[1]);
}));
console.log(`${stamp()} invite: ${invite}`);

const carol = await player('Carol');
await carol.goto(site);
await carol.waitForTimeout(2000);
console.log(`${stamp()} Carol sees: ${(await carol.textContent('#games')).replace(/\s+/g, ' ').trim()}`);
await carol.close();

const bob = await player('Bob');
await bob.goto(invite);
await bob.fill('#name', 'Bob');
console.log(`${stamp()} Bob's code field: ${await bob.inputValue('#code')}`);
await bob.click('#play');

await alice.waitForTimeout(30000);
for (const p of [alice, bob]) { await p.mouse.click(480, 300); await p.keyboard.press('1'); }
if (process.env.HIDE === '1') {
  // Alice switches to another tab: her browser must keep serving Bob. Headless
  // tabs never become hidden, so do what a browser does: report hidden and
  // hold back animation frames until the tab is shown again.
  await alice.evaluate(() => {
    window.__held = [];
    window.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0; };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.__frames = 0;
    const f = window.ioq3Module._Sys_WebBackgroundFrame;
    window.ioq3Module._Sys_WebBackgroundFrame = () => { window.__frames++; f(); };
  });
  await alice.evaluate(() => {
    const net = window.ioq3Module.urtNet;
    window.__io = { sent: 0, recv: 0 };
    const send = net.ws.send.bind(net.ws);
    net.ws.send = (f) => { window.__io.sent++; send(f); };
    const push = net.recv.push.bind(net.recv);
    net.recv.push = (f) => { window.__io.recv++; return push(f); };
  });
  for (let i = 0; i < 5; i++) {
    await alice.waitForTimeout(3000);
    console.log(`${stamp()} Alice hidden: ${JSON.stringify(await alice.evaluate(() => ({ ...window.__io, frames: window.__frames, queued: window.ioq3Module.urtNet.recv.length })))}`);
  }
  console.log(`${stamp()} background frames on Alice in 15s: ${await alice.evaluate(() => window.__frames)}`);
  await bob.screenshot({ path: `${out}/p2p-bob-hidden.png` });
  await alice.evaluate(() => {
    delete document.hidden;
    window.requestAnimationFrame = window.__raf;
    for (const cb of window.__held.splice(0)) window.__raf(cb);
  });
}
await alice.waitForTimeout(Math.max(5000, Number(seconds) * 1000 - 30000));
await alice.screenshot({ path: `${out}/p2p-alice.png` });
await bob.screenshot({ path: `${out}/p2p-bob.png` });
console.log(`${stamp()} Alice's invite button: ${await alice.textContent('#invite')}`);
await browser.close();
