// Host settings + game browser: Alice hosts a password-protected CTF game with a
// custom map rotation; Carol reads the listing; Dave tries a wrong password;
// Bob picks the game from the browser and joins with the right one.
// usage: node p2p-settings.mjs <site-url> [outdir]
import { chromium } from 'playwright';
const [site, out = '/runs'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/entered the game|password|urt:|ERROR|disconnect/i.test(t)) console.log(`${stamp()} ${name}: ${t}`);
  });
  page.on('pageerror', (e) => console.log(`${stamp()} ${name} pageerror: ${e.message}`));
  return page;
}

const alice = await player('Alice');
await alice.goto(site);
await alice.fill('#name', 'Alice');
await alice.click('[data-tab=host]');
await alice.fill('#hostName', 'Alice CTF night');
await alice.fill('#hostPass', 'hunter2');
await alice.selectOption('#gametype', '7');
await alice.selectOption('#maxPlayers', '6');
await alice.selectOption('#timelimit', '15');
console.log(`${stamp()} CTF limit field: ${await alice.textContent('#limitLabel')} [${await alice.$$eval('#limit option', (o) => o.map((x) => x.textContent).join(', '))}]`);
await alice.selectOption('#limit', '5');
// rotation: casa then abbey only (the last map can't be removed, so add first, then drop the leftover)
for (const m of await alice.$$eval('#maps .on', (b) => b.map((x) => x.dataset.map))) await alice.click(`#maps [data-map=${m}]`);
const [left] = await alice.$$eval('#maps .on', (b) => b.map((x) => x.dataset.map));
for (const m of ['ut4_casa', 'ut4_abbey']) if (m !== left) await alice.click(`#maps [data-map=${m}]`);
if (left !== 'ut4_casa' && left !== 'ut4_abbey') await alice.click(`#maps [data-map=${left}]`);
console.log(`${stamp()} rotation chips: ${(await alice.$$eval('#maps .on', (b) => b.map((x) => x.textContent))).join(' ')}`);
await alice.screenshot({ path: `${out}/settings-host-form.png` });
await alice.click('#play');
await new Promise((resolve) => alice.on('console', (m) => /invite link/.test(m.text()) && resolve()));
await alice.waitForTimeout(8000);
const cvars = await alice.evaluate(() => Object.fromEntries(
  ['sv_hostname', 'g_gametype', 'sv_maxclients', 'timelimit', 'capturelimit', 'g_friendlyFire', 'g_password', 'mapname', 'g_mapcycle', 'g_nextmap']
    .map((c) => [c, window.ioq3Module.ccall('Sys_WebCvar', 'string', ['string'], [c])])));
console.log(`${stamp()} Alice server cvars: ${JSON.stringify(cvars)}`);
console.log(`${stamp()} Alice mapcycle.txt: ${JSON.stringify(await alice.evaluate(() => window.ioq3Module.FS.readFile('/q3ut4/mapcycle.txt', { encoding: 'utf8' })))}`);

const carol = await player('Carol');
await carol.goto(site);
await carol.waitForTimeout(2500);
console.log(`${stamp()} Carol's browser: ${(await carol.textContent('#games')).replace(/\s+/g, ' ').trim()}`);
await carol.selectOption('#modeFilter', '4');
console.log(`${stamp()} Carol filtered to TS: ${(await carol.textContent('#games')).replace(/\s+/g, ' ').trim()}`);
await carol.selectOption('#modeFilter', '');
await carol.click('#games .server:has-text("Alice CTF night")');
console.log(`${stamp()} Carol password field visible: ${await carol.isVisible('#joinPassField')}`);
await carol.screenshot({ path: `${out}/settings-browser.png` });
await carol.close();

const dave = await player('Dave');
await dave.goto(site);
await dave.fill('#name', 'Dave');
await dave.waitForTimeout(2500);
await dave.click('#games .server:has-text("Alice CTF night")');
await dave.fill('#joinPass', 'wrong');
await dave.click('#play');
await dave.waitForURL(/./, { waitUntil: 'load' });
await dave.waitForSelector('#status .error', { timeout: 30000 });
console.log(`${stamp()} Dave back in the lobby: "${await dave.textContent('#status')}", password field visible: ${await dave.isVisible('#joinPass')}, game picked: ${await dave.isVisible('#games .server.on')}`);
await dave.screenshot({ path: `${out}/settings-dave-retry.png` });
await dave.fill('#joinPass', 'hunter2');
await dave.click('#play');

const bob = await player('Bob');
await bob.goto(site);
await bob.fill('#name', 'Bob');
await bob.waitForTimeout(2500);
await bob.click('#games .server:has-text("Alice CTF night")');
await bob.fill('#joinPass', 'hunter2');
await bob.click('#play');

await alice.waitForTimeout(30000);
for (const p of [alice, bob, dave]) { await p.mouse.click(550, 450); await p.keyboard.press('1'); }
await alice.waitForTimeout(8000);
const players = await alice.evaluate(() => window.ioq3Module._SV_WebPlayerCount());
console.log(`${stamp()} Alice's server counts ${players} players; invite button: ${await alice.textContent('#invite')}`);
const r = await (await fetch(new URL('signal/rooms', site))).json();
console.log(`${stamp()} listing: ${JSON.stringify(r)}`);
await bob.screenshot({ path: `${out}/settings-bob.png` });
await dave.screenshot({ path: `${out}/settings-dave.png` });
await browser.close();
