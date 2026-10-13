// WebXR: play in a VR headset (see src/ioq3/code/renderercommon/tr_webxr.h).
//
// While a session runs, the engine's frames come from the headset instead of the
// page: each XR animation frame runs one engine frame, which reads the head and
// controller state through poll() and draws the screen once per eye into the
// canvas, calling copyEye() after each to scale it into that eye's half of the
// XR framebuffer.

// buttons, as cl_webxr.c's WEBXR_BTN_* bits; xr-standard gamepad indices
const RIGHT = { 0: 1 << 0, 1: 1 << 1, 4: 1 << 2, 5: 1 << 3, 3: 1 << 4 }; // trigger grip A B stick
const LEFT = { 0: 1 << 5, 1: 1 << 6, 4: 1 << 7, 5: 1 << 8, 3: 1 << 9 }; //  trigger grip X Y stick

export async function vrSupported() {
  try {
    return !!(window.isSecureContext && navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'));
  } catch {
    return false;
  }
}

// The WebGL context has to be made for XR; ask for that before the engine creates
// it (making an existing one compatible later can lose and restore it).
export function makeContextsXRCompatible() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') attrs = { ...attrs, xrCompatible: true };
    return getContext.call(this, type, attrs);
  };
}

// Starts a session; call from a click. onEnd runs when it ends, however that happens.
export async function enterVR(module, { onEnd } = {}) {
  // (asking for the type it already has returns the engine's context)
  const gl = module.canvas.getContext('webgl2');
  if (!gl) throw new Error('VR needs WebGL 2');
  const session = await navigator.xr.requestSession('immersive-vr');
  let space, layer, frame = null, views = [];
  try {
    await gl.makeXRCompatible?.();
    layer = makeLayer(session, gl);
    await session.updateRenderState({ baseLayer: layer, depthNear: 1, depthFar: 10000 });
    space = await session.requestReferenceSpace('local');
  } catch (err) {
    session.end().catch(() => {});
    throw err;
  }

  const xr = {
    active: true,
    session,

    // Fills the engine's view of the headset (WEBXR_IN_* in tr_webxr.h).
    poll(a) {
      if (!frame) return;
      const pose = frame.getViewerPose(space);
      if (!pose || pose.views.length < 2) return;
      const head = pose.transform, inv = head.inverse.matrix;
      a[0] = 1;
      a.set([head.orientation.x, head.orientation.y, head.orientation.z, head.orientation.w], 1);
      a.set([head.position.x, head.position.y, head.position.z], 5);
      views = [...pose.views].sort((v, w) => (v.eye === 'right') - (w.eye === 'right')).slice(0, 2);
      views.forEach((view, i) => {
        const m = view.projectionMatrix, p = view.transform.position, o = 8 + i * 7;
        a.set([(m[8] - 1) / m[0], (m[8] + 1) / m[0], (m[9] - 1) / m[5], (m[9] + 1) / m[5]], o);
        // the eye's position in the head's frame
        a[o + 4] = inv[0] * p.x + inv[4] * p.y + inv[8] * p.z + inv[12];
        a[o + 5] = inv[1] * p.x + inv[5] * p.y + inv[9] * p.z + inv[13];
        a[o + 6] = inv[2] * p.x + inv[6] * p.y + inv[10] * p.z + inv[14];
      });
      let buttons = 0;
      for (const source of session.inputSources) {
        const pad = source.gamepad;
        if (!pad || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
        const right = source.handedness === 'right', bits = right ? RIGHT : LEFT;
        // xr-standard puts the thumbstick on axes 2 and 3; others only have 0 and 1
        const [x, y] = pad.axes.length >= 4 ? [pad.axes[2], pad.axes[3]] : [pad.axes[0] || 0, pad.axes[1] || 0];
        a[right ? 24 : 22] = x;
        a[right ? 25 : 23] = y;
        for (const [i, bit] of Object.entries(bits)) if (pad.buttons[i]?.pressed) buttons |= bit;
      }
      a[26] = buttons;
    },

    // The canvas holds eye `eye`: scale it into that eye's viewport.
    copyEye(eye) {
      const view = views[eye], target = session.renderState.baseLayer;
      if (!frame || !view || !target) return;
      const vp = target.getViewport(view);
      const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      gl.blitFramebuffer(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        vp.x, vp.y, vp.x + vp.width, vp.y + vp.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
    },
  };

  const onFrame = (time, xrFrame) => {
    session.requestAnimationFrame(onFrame);
    frame = xrFrame;
    try {
      module._Sys_WebBackgroundFrame();
    } finally {
      frame = null;
    }
  };

  session.addEventListener('end', () => {
    xr.active = false;
    module.urtXR = null; // the browser's frames run the engine again
    onEnd?.();
  });

  // the headset's frames run the engine from now on (the page's are skipped)
  module.urtXR = xr;
  session.requestAnimationFrame(onFrame);
  return xr;
}

// The canvas is scaled into each eye; render the eyes at about its size rather
// than the headset's (often much larger) recommended one, which would only cost.
function makeLayer(session, gl) {
  const opts = { antialias: false, depth: false, stencil: false, alpha: false };
  let layer = new XRWebGLLayer(session, gl, opts);
  const eyeHeight = layer.framebufferHeight, canvasHeight = gl.drawingBufferHeight;
  if (eyeHeight > canvasHeight * 1.1) {
    layer = new XRWebGLLayer(session, gl, { ...opts, framebufferScaleFactor: canvasHeight / eyeHeight });
  }
  return layer;
}
