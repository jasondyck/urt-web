// WebXR test with a fake headset (Quest-2-like asymmetric eyes): join from the
// lobby at the VR render size, enter VR, turn/tilt the head, walk with the stick,
// open the menu, leave VR. Saves both-eye snapshots of the XR framebuffer.
// usage: node xr.mjs <url> [name]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [url, name = 'VRTester'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

await ctx.addInitScript(() => {
  const S = window.__xr = { yaw: 0, pitch: 0, roll: 0, pos: [0, 0, 0], left: [0, 0], right: [0, 0], buttons: { left: [], right: [] }, frames: 0, active: false };
  const EYE = { left: [-1.0, 0.84, -1.06, 0.92], right: [-0.84, 1.0, -1.06, 0.92] }; // tan l r d u
  const W = 1832, H = 1920, IPD = 0.064;
  const d2r = Math.PI / 180;
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const axisq = (ax, deg) => { const s = Math.sin(deg * d2r / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(deg * d2r / 2)]; };
  const rot = ([x, y, z, w]) => [ // column-major 3x3
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  const apply = (r, v) => [r[0] * v[0] + r[3] * v[1] + r[6] * v[2], r[1] * v[0] + r[4] * v[1] + r[7] * v[2], r[2] * v[0] + r[5] * v[1] + r[8] * v[2]];
  function pose() {
    const q = qmul(qmul(axisq([0, 1, 0], S.yaw), axisq([1, 0, 0], S.pitch)), axisq([0, 0, 1], S.roll));
    const r = rot(q), p = S.pos;
    // inverse: R^T, -R^T p
    const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
    const ip = apply(rt, p).map((v) => -v);
    const inv = new Float32Array([rt[0], rt[1], rt[2], 0, rt[3], rt[4], rt[5], 0, rt[6], rt[7], rt[8], 0, ip[0], ip[1], ip[2], 1]);
    const views = ['left', 'right'].map((eye) => {
      const [l, rr, b, t] = EYE[eye], n = 0.1, f = 1000;
      const m = new Float32Array(16);
      m[0] = 2 / (rr - l); m[8] = (rr + l) / (rr - l); m[5] = 2 / (t - b); m[9] = (t + b) / (t - b);
      m[10] = -(f + n) / (f - n); m[11] = -1; m[14] = -2 * f * n / (f - n);
      const o = apply(r, [(eye === 'left' ? -1 : 1) * IPD / 2, 0, 0]);
      return { eye, projectionMatrix: m, transform: { position: { x: p[0] + o[0], y: p[1] + o[1], z: p[2] + o[2] } } };
    });
    return {
      transform: { orientation: { x: q[0], y: q[1], z: q[2], w: q[3] }, position: { x: p[0], y: p[1], z: p[2] }, inverse: { matrix: inv } },
      views,
    };
  }
  class XRWebGLLayer {
    constructor(session, gl, opts = {}) {
      const k = opts.framebufferScaleFactor || 1;
      this.framebufferWidth = Math.round(2 * W * k);
      this.framebufferHeight = Math.round(H * k);
      const tex = gl.getParameter(gl.TEXTURE_BINDING_2D), fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.framebufferWidth, this.framebufferHeight);
      this.framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      S.layer = this;
      S.gl = gl;
    }
    getViewport(view) {
      const w = this.framebufferWidth / 2;
      return { x: view.eye === 'left' ? 0 : w, y: 0, width: w, height: this.framebufferHeight };
    }
  }
  window.XRWebGLLayer = XRWebGLLayer;
  // the real one rejects without a headset
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => {};
  const pad = (hand) => ({
    get axes() { const a = S[hand]; return [0, 0, a[0], a[1]]; },
    get buttons() { return [0, 1, 2, 3, 4, 5].map((i) => ({ pressed: !!S.buttons[hand][i] })); },
  });
  function makeSession() {
    const session = new EventTarget();
    session.renderState = {};
    session.updateRenderState = async (s) => { Object.assign(session.renderState, s); };
    session.requestReferenceSpace = async () => ({});
    session.inputSources = [{ handedness: 'left', gamepad: pad('left') }, { handedness: 'right', gamepad: pad('right') }];
    session.requestAnimationFrame = (cb) => setTimeout(() => {
      if (!S.active) return;
      S.frames++;
      cb(performance.now(), { getViewerPose: () => pose() });
    }, 11);
    session.end = async () => { S.active = false; session.dispatchEvent(new Event('end')); };
    S.session = session;
    S.active = true;
    return session;
  }
  Object.defineProperty(navigator, 'xr', { value: { isSessionSupported: async (m) => m === 'immersive-vr', requestSession: async () => makeSession() } });

  // both eyes, half size, as a PNG data URL
  S.snap = () => {
    const gl = S.gl, L = S.layer, w = L.framebufferWidth, h = L.framebufferHeight;
    const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, L.framebuffer);
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const c2 = c.getContext('2d');
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    c2.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = w / 2; out.height = h / 2;
    out.getContext('2d').drawImage(c, 0, 0, w / 2, h / 2);
    return out.toDataURL('image/png');
  };
});

const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (/Welcome to Urban|entered the game|ERROR|error|VR/i.test(t)) log(t); });
page.on('pageerror', (e) => log('pageerror: ' + e.message));
const snap = async (tag) => {
  const data = await page.evaluate(() => window.__xr.snap());
  writeFileSync(`/runs/xr-${tag}.png`, Buffer.from(data.split(',')[1], 'base64'));
  log(`snap ${tag} (frames ${await page.evaluate(() => window.__xr.frames)})`);
};
const set = (o) => page.evaluate((o) => Object.assign(window.__xr, o), o);

await page.goto(url);
await page.waitForTimeout(1500);
log(`VR option visible: ${await page.evaluate(() => !document.getElementById('resVR').hidden)}`);
await page.fill('#name', name);
await page.selectOption('#res', 'vr');
await page.click('#play');
await page.waitForEvent('console', { predicate: (m) => /Welcome to Urban/.test(m.text()), timeout: 300000 });
log('in game');
await page.waitForTimeout(4000);
await page.screenshot({ path: '/runs/xr-flat.png' });
log(`VR button visible: ${await page.isVisible('#vr')}`);
// close the team menu: auto-join
await page.focus('#canvas');
await page.keyboard.press('1');
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById('vr').click());
await page.waitForTimeout(3000);
log(`button: ${await page.textContent('#vr')}`);
await snap('0-ahead');
await set({ yaw: 60 });
await page.waitForTimeout(800);
await snap('1-yaw60');
await set({ yaw: 60, pitch: -30, roll: 20 });
await page.waitForTimeout(800);
await snap('2-down-roll');
await set({ pitch: 0, roll: 0 });
await set({ left: [0, -1] });
await page.waitForTimeout(2000);
await set({ left: [0, 0] });
await page.waitForTimeout(500);
await snap('3-walked');
await set({ right: [1, 0] }); // snap turn right
await page.waitForTimeout(300);
await set({ right: [0, 0] });
await page.waitForTimeout(500);
await snap('4-snapturn');
await page.evaluate(() => { window.__xr.buttons.left[3] = 1; });
await page.waitForTimeout(200);
await page.evaluate(() => { window.__xr.buttons.left[3] = 0; });
await page.waitForTimeout(800);
await snap('5-menu');
const before = await page.evaluate(() => window.__xr.frames);
await page.evaluate(() => window.__xr.session.end());
await page.waitForTimeout(1500);
log(`after end: xr frames ${await page.evaluate(() => window.__xr.frames) - before}, button: ${await page.textContent('#vr')}`);
await page.screenshot({ path: '/runs/xr-after.png' });
await browser.close();
