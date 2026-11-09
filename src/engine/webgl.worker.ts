import { WebGLEngine } from './WebGLEngine';
import type { WebGLWorkerRequest, WebGLWorkerResponse } from './WorkerWebGLEngine';

const channel = self as unknown as {
  onmessage: (event: MessageEvent<WebGLWorkerRequest>) => void;
  postMessage: (message: WebGLWorkerResponse) => void;
};

let engine: WebGLEngine | undefined;
let canvas: OffscreenCanvas | undefined;

channel.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      canvas = data.canvas;
      engine = new WebGLEngine(canvas, data.testMode);
      engine.onCompileProgress = (stage, percent) => channel.postMessage({ type: 'progress', stage, percent });
      canvas.addEventListener('webglcontextlost', () => channel.postMessage({
        type: 'fatal', message: 'Offscreen WebGL context lost',
      }), { once: true });
      if (!engine.init()) throw new Error('Offscreen WebGL2 is unavailable');
      channel.postMessage({ type: 'ready', rendererInfo: engine.rendererInfo });
      return;
    }
    if (!engine || !canvas) return;
    switch (data.type) {
      case 'quality':
        engine.setQualityLevel(data.level);
        break;
      case 'prefetch':
        engine.prefetchFractal(data.index);
        break;
      case 'frame': {
        if (canvas.width !== data.width) canvas.width = data.width;
        if (canvas.height !== data.height) canvas.height = data.height;
        const drawn = engine.render(data.time, data.params);
        const response: WebGLWorkerResponse = {
          type: 'frame', drawn, swapping: engine.isShaderSwapping(), progress: engine.getSwapProgress(),
          canPrefetch: engine.canPrefetch, quality: engine.qualityLevel,
        };
        if (drawn && data.capture) {
          try {
            response.screenshot = await canvas.convertToBlob({ type: 'image/png' });
          } catch (error) {
            response.error = error instanceof Error ? error.message : String(error);
          }
        }
        channel.postMessage(response);
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (data.type === 'frame' && engine) {
      channel.postMessage({
        type: 'frame', drawn: false, swapping: engine.isShaderSwapping(), progress: engine.getSwapProgress(),
        canPrefetch: engine.canPrefetch, quality: engine.qualityLevel, error: message,
      });
    } else {
      channel.postMessage({ type: 'fatal', message });
    }
  }
};
