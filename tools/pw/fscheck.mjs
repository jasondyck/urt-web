import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(process.argv[2]);
await page.fill('#name', 'Fs'); await page.click('#play');
await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 120000 });
console.log(await page.evaluate(() => { const b = document.getElementById('fs'); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const c = document.getElementById('canvas'); return JSON.stringify({ canvasStyle: c.getAttribute('style'), canvasZ: getComputedStyle(c).zIndex, canvasPos: getComputedStyle(c).position, r, display: getComputedStyle(b).display, topmost: top && (top.id || top.tagName), parent: b.parentElement.id, gameChildren: [...document.getElementById('game').children].map((c) => c.tagName + '#' + c.id) }); }));
await browser.close();
