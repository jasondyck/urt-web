import { chromium } from 'playwright';
for (const args of [
  ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE'],
  ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'],
]) {
  const b = await chromium.launch({ headless: true, args });
  const p = await b.newPage();
  console.log(args.slice(2).join(' '), '=>', await p.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return 'no webgl2';
    const e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
  }));
  await b.close();
}
