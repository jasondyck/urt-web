// Uncapped frame rate at a given render size, to compare renderer settings.
// usage: node gpubench.mjs <engine-url-with-args> <w> <h>
import { chromium } from 'playwright';
const [url, w, h] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: Number(w) / 2, height: Number(h) / 2 }, deviceScaleFactor: 2 });
await page.goto(`${url}%20%2bset%20r_mode%20-1%20%2bset%20r_customwidth%20${w}%20%2bset%20r_customheight%20${h}%20%2bset%20r_fullscreen%200%20%2bset%20cg_draw2d%200`);
await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 120000 });
await page.waitForTimeout(4000);
// close the team menu so the full 3D view renders
await page.mouse.click(10, 10); await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
const fps = await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 6000 ? requestAnimationFrame(f) : r(n / 6); }; requestAnimationFrame(f); }));
console.log(`${w}x${h}: ${fps.toFixed(0)} fps`);
await page.screenshot({ path: `/runs/gpubench-${process.env.TAG || 'x'}.png` });
await browser.close();
