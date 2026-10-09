// Load the urt-web client headlessly; dump console + periodic screenshots.
// usage: node run.mjs <url> [seconds] [outdir] [tag]
import { chromium } from 'playwright';
import { execSync } from 'child_process';
const [url, seconds = '60', out = '/runs', tag = 'run'] = process.argv.slice(2);
const gpu = process.env.GPU === '1';
const browser = await chromium.launch({ headless: true, args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--enable-precise-memory-info'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
page.on('console', (m) => log(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
if (process.env.NOALPHA === '1') await page.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/.test(type)) { console.log('[gl] ctx attrs ' + JSON.stringify(attrs)); attrs = { ...(attrs || {}), alpha: false }; }
    return orig.call(this, type, attrs);
  };
});
if (process.env.SKYTRACE === '1') await page.addInitScript(() => {
  const C = WebGL2RenderingContext.prototype;
  let inSky = false, logged = 0, frames = 0;
  const dims = new WeakMap();
  for (const fn of ['texImage2D', 'texStorage2D', 'texSubImage2D', 'compressedTexImage2D']) {
    const o = C[fn];
    C[fn] = function (...a) {
      const t = this.getParameter(this.TEXTURE_BINDING_2D);
      if (t && a[0] === this.TEXTURE_2D) {
        const d = dims.get(t) || { calls: [] };
        if (d.calls.length < 4) d.calls.push(`${fn}(lvl=${fn === 'texStorage2D' ? 'L' + a[1] : a[1]}, ifmt=${a[2]}, ${a[3]}x${a[4]}${fn === 'texImage2D' ? `, fmt=${a[6]}, type=${a[7]}` : ''}${fn === 'texSubImage2D' ? `, fmt=${a[6]}, type=${a[7]}` : ''}) err=?`);
        dims.set(t, d);
      }
      const r = o.apply(this, a);
      const e = this.getError();
      if (t && a[0] === this.TEXTURE_2D) { const d = dims.get(t); d.calls[d.calls.length - 1] = d.calls[d.calls.length - 1].replace('err=?', 'err=' + e); }
      return r;
    };
  }
  window.__tex8 = (gl) => { const t = gl.getParameter(gl.TEXTURE_BINDING_2D); const d = t && dims.get(t); return d && /8x8/.test(d.calls[0]); };
  window.__texinfo = (gl) => { const t = gl.getParameter(gl.TEXTURE_BINDING_2D); return t ? JSON.stringify(dims.get(t)) : 'none'; };
  const dr = C.depthRange;
  let after = -1, sinceSky = -1;
  let pix = 0;
  const px = (gl, tag) => { if (pix > 12) return; pix++; const b = new Uint8Array(4); gl.readPixels(1000, 750, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); console.log(`[px] ${tag} ${b}`); };
  window.__px = px;
  C.depthRange = function (n, f) { if (n === f && !inSky) px(this, 'before-sky'); if (inSky && n !== f) { px(this, 'after-sky'); sinceSky = 0; if (after < 0 && logged >= 5) after = 0; } inSky = (n === f); if (inSky && logged < 12) console.log(`[sky] depthRange(${n},${f})`); return dr.call(this, n, f); };
  const de = C.drawElements;
  C.drawElements = function (mode, count, type, off) {
    if (inSky && logged < 12) {
      logged++;
      const tex = this.getParameter(this.TEXTURE_BINDING_2D);
      console.log(`[sky] drawElements count=${count} active=${this.getParameter(this.ACTIVE_TEXTURE) - this.TEXTURE0} depthTest=${this.isEnabled(this.DEPTH_TEST)} func=${this.getParameter(this.DEPTH_FUNC)} mask=${this.getParameter(this.COLOR_WRITEMASK)} blend=${this.isEnabled(this.BLEND)} fb=${!!this.getParameter(this.FRAMEBUFFER_BINDING)} tex=${window.__texinfo(this)}`);
    }
    if (sinceSky >= 0) { sinceSky++; if (pix < 60 && sinceSky <= 40) { const r = de.call(this, mode, count, type, off); const b = new Uint8Array(4); this.readPixels(1000, 750, 1, 1, this.RGBA, this.UNSIGNED_BYTE, b); pix++; const units = []; const at = this.getParameter(this.ACTIVE_TEXTURE); for (let u = 0; u < 4; u++) { this.activeTexture(this.TEXTURE0 + u); units.push((/(\d+x\d+)/.exec(window.__texinfo(this)) || ['', '-'])[1]); } this.activeTexture(at);
        const prg = this.getParameter(this.CURRENT_PROGRAM); const fs = this.getAttachedShaders(prg).map(x => this.getShaderSource(x)).find(x => x.includes('out_Color')) || ''; const defs = (fs.match(/#define (USE_\w+|RGBM\w*|r_\w+)/g) || []).map(x => x.slice(8)).join(',');
        if (sinceSky === 15 || sinceSky === 16) {
          const samp = []; const fbOld = this.getParameter(this.FRAMEBUFFER_BINDING); const fb = this.createFramebuffer(); this.bindFramebuffer(this.FRAMEBUFFER, fb);
          for (let u = 0; u < 2; u++) { this.activeTexture(this.TEXTURE0 + u); const t = this.getParameter(this.TEXTURE_BINDING_2D); this.framebufferTexture2D(this.FRAMEBUFFER, this.COLOR_ATTACHMENT0, this.TEXTURE_2D, t, 0); const b = new Uint8Array(16); this.readPixels(0, 0, 2, 2, this.RGBA, this.UNSIGNED_BYTE, b); samp.push(`${this.checkFramebufferStatus(this.FRAMEBUFFER)}:${b.slice(0, 8)}`); }
          this.activeTexture(at); this.bindFramebuffer(this.FRAMEBUFFER, fbOld); this.deleteFramebuffer(fb);
          console.log(`[px] units=${units} defs=${defs} samples=${samp.join(' | ')}`);
        }
        console.log(`[px] draw ${sinceSky} count=${count} tex=${(/(\d+x\d+)/.exec(window.__texinfo(this)) || [])[1]} blend=${this.isEnabled(this.BLEND)} prog=${!!this.getParameter(this.CURRENT_PROGRAM)} -> ${b}`); return r; } if (sinceSky === 1 && window.__tex8(this) && location.search.includes('skip8')) return; }
    if (after >= 0 && after < 25) {
      after++;
      const t = window.__texinfo(this); const m = /(\d+x\d+)/.exec(t);
      console.log(`[after] #${after} count=${count} depthTest=${this.isEnabled(this.DEPTH_TEST)} depthMask=${this.getParameter(this.DEPTH_WRITEMASK)} blend=${this.isEnabled(this.BLEND)} src=${this.getParameter(this.BLEND_SRC_RGB)} dst=${this.getParameter(this.BLEND_DST_RGB)} tex=${m ? m[1] : t} fb=${!!this.getParameter(this.FRAMEBUFFER_BINDING)}`);
    }
    return de.call(this, mode, count, type, off);
  };
  const da = C.drawArrays;
  C.drawArrays = function (mode, first, count) {
    if (after >= 0 && after < 25) { after++; console.log(`[after] #${after} drawArrays count=${count}`); }
    return da.call(this, mode, first, count);
  };
});
if (process.env.DBG) await page.addInitScript((expr) => {
  for (const C of [WebGL2RenderingContext.prototype]) {
    const o = C.shaderSource;
    C.shaderSource = function (sh, src) {
      if (src.includes('u_DeluxeMap') && src.includes('out_Color')) {
        const i = src.lastIndexOf('gl_FragColor.a = alpha;');
        if (i > 0) src = src.slice(0, i) + `gl_FragColor.a = alpha;\n#if defined(USE_LIGHT) && !defined(USE_FAST_LIGHT)\ngl_FragColor.rgb = ${expr};\n#endif\n` + src.slice(i + 'gl_FragColor.a = alpha;'.length);
      }
      return o.call(this, sh, src);
    };
  }
}, process.env.DBG);
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
// CMDS="cmd1;cmd2" are typed into the engine console at CMDS_AT seconds
const cmds = (process.env.CMDS || '').split(';').filter(Boolean);
for (let s = 10; s <= Number(seconds); s += 10) {
  await page.waitForTimeout(10000);
  if (cmds.length && s === Number(process.env.CMDS_AT || 30)) {
    await page.keyboard.press('Shift+Escape');
    for (const c of cmds) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await page.waitForTimeout(300); }
    await page.keyboard.press('Shift+Escape');
  }
  await page.screenshot({ path: `${out}/${tag}-${s}s.png` });
  if (process.env.MEMSTATS === '1') log('[rss] ' + execSync("ps -eo rss,args | grep -E 'type=(renderer|gpu-process)' | grep -v grep | awk '{t=$2; for(i=2;i<=NF;i++) if($i ~ /--type=/) t=$i; printf \"%s=%dMB \", t, $1/1024}'").toString());
  if (process.env.MEMSTATS === '1') log('[mem] ' + JSON.stringify(await page.evaluate(() => ({
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    wasmMB: window.ioq3Module ? Math.round(window.ioq3Module.HEAPU8.length / 1e6) : null,
    memfsMB: window.ioq3Module ? Math.round((function walk(n) { let t = 0; for (const c of Object.values(n.contents || {})) t += c.contents && c.contents.length !== undefined ? (c.usedBytes || c.contents.length) : walk(c); return t; })(window.ioq3Module.FS.lookupPath('/q3ut4').node) / 1e6) : null,
  }))));
}
log('done');
await browser.close();
