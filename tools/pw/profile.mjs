// CPU-profile the client for N seconds after navigation; print top functions by self time.
// usage: node profile.mjs <url> [seconds] [top]
import { chromium } from 'playwright';
const [url, seconds = '30', top = '40'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
const t0 = Date.now();
page.on('console', (m) => { const t = m.text(); if (/CL_InitCGame|Welcome to Urban/.test(t)) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${t}`); });
await page.goto(url);
await page.waitForTimeout(Number(seconds) * 1000);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas; let total = 0;
profile.samples.forEach((id, i) => {
  const n = byId.get(id); const name = n.callFrame.functionName || `(${n.callFrame.url.split('/').pop()})`;
  const d = dt[i] || 0; total += d; self.set(name, (self.get(name) || 0) + d);
});
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(top));
console.log(`total sampled ${(total / 1e6).toFixed(1)}s`);
for (const [name, us] of rows) console.log(`${(us / 1e6).toFixed(2).padStart(7)}s ${(100 * us / total).toFixed(1).padStart(5)}%  ${name}`);
await browser.close();
