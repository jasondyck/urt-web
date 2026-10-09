import { chromium } from 'playwright';
import fs from 'fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage(); page.on('console', m => console.log(m.text()));
console.log(await page.evaluate((src) => {
  const gl = document.createElement('canvas').getContext('webgl2'); const exts = gl.getSupportedExtensions(); const bad = [];
  for (const e of exts) { gl.getExtension(e); const s0 = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(s0, src); gl.compileShader(s0); if (!gl.getShaderParameter(s0, gl.COMPILE_STATUS)) { bad.push(e); break; } }
  console.log('first breaking ext: ' + bad);
  const s = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(s, src); gl.compileShader(s);
  return `ok=${gl.getShaderParameter(s, gl.COMPILE_STATUS)} lost=${gl.isContextLost()} err=${gl.getError()} log=${gl.getShaderInfoLog(s)}`;
}, src));
await browser.close();
