// Load the urt-web client headlessly; dump console + periodic screenshots.
// usage: node run.mjs <url> [seconds] [outdir] [tag]
import { chromium } from 'playwright';
const [url, seconds = '60', out = '/runs', tag = 'run'] = process.argv.slice(2);
const gpu = process.env.GPU === '1';
const browser = await chromium.launch({ headless: true, args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
page.on('console', (m) => log(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const orig = C.prototype.compileShader;
    C.prototype.compileShader = function (sh) {
      orig.call(this, sh); window.__nc = (window.__nc || 0) + 1;
      if (!this.getShaderParameter(sh, this.COMPILE_STATUS))
        console.log(`[gl] compile #${window.__nc} failed lost=${this.isContextLost()} err=${this.getError()} log=${this.getShaderInfoLog(sh)} src=${JSON.stringify(this.getShaderSource(sh))}`);
    };
  }
});
await page.goto(url);
for (let s = 10; s <= Number(seconds); s += 10) {
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${out}/${tag}-${s}s.png` });
}
log('done');
await browser.close();
