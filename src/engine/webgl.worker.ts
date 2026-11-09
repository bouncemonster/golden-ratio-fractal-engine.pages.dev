import { WebGLEngine } from './WebGLEngine';
import type { WebGLWorkerRequest, WebGLWorkerResponse } from './WorkerWebGLEngine';

type Endpoint = {
  onmessage: ((event: MessageEvent<WebGLWorkerRequest>) => void) | null;
  postMessage(message: WebGLWorkerResponse): void;
  postMessage(message: WebGLWorkerResponse, transfer: Transferable[]): void;
};

type RenderSession = {
  canvas: OffscreenCanvas;
  engine: WebGLEngine;
  client?: Endpoint;
  testMode: boolean;
  lost: boolean;
};

const scope = self as unknown as Endpoint & {
  onconnect?: (event: MessageEvent) => void;
};

// The shared worker is named per browser tab. Only released renderers can be
// reused. Two live ports (for example, a duplicated tab) have separate engines.
const RETURN_WINDOW_MS = 20_000;
let parked: { session: RenderSession; timeout: ReturnType<typeof setTimeout> } | undefined;

function takeParked(): RenderSession | undefined {
  if (!parked) return;
  clearTimeout(parked.timeout);
  const session = parked.session;
  parked = undefined;
  return session;
}

function park(session: RenderSession) {
  takeParked()?.engine.destroy();
  parked = {
    session,
    timeout: setTimeout(() => takeParked()?.engine.destroy(), RETURN_WINDOW_MS),
  };
}

function startSession(canvas: OffscreenCanvas, testMode: boolean, client: Endpoint): RenderSession {
  const engine = new WebGLEngine(canvas, testMode);
  const session = { canvas, engine, client, testMode, lost: false };
  engine.onCompileProgress = (stage, percent) => {
    session.client?.postMessage({ type: 'progress', stage, percent });
  };
  canvas.addEventListener('webglcontextlost', () => {
    session.lost = true;
    session.client?.postMessage({ type: 'fatal', message: 'Offscreen WebGL context lost' });
  }, { once: true });
  if (!engine.init()) {
    engine.destroy();
    throw new Error('Offscreen WebGL2 is unavailable');
  }
  return session;
}

function connect(client: Endpoint, port?: MessagePort) {
  let active: RenderSession | undefined;
  function release(keepWarm: boolean) {
    if (active) {
      const session = active;
      active = undefined;
      session.client = undefined;
      if (keepWarm && !session.lost) park(session);
      else session.engine.destroy();
    }
    port?.close();
  }

  port?.addEventListener('close', () => release(true), { once: true });
  client.onmessage = async ({ data }) => {
    try {
      if (data.type === 'init' || data.type === 'attach') {
        if (active) return;
        let resumed = false;
        if (data.type === 'attach') {
          const previous = takeParked();
          if (previous && !previous.lost && previous.testMode === data.testMode) {
            active = previous;
            active.client = client;
            resumed = true;
          } else {
            previous?.engine.destroy();
            active = startSession(new OffscreenCanvas(data.width, data.height), data.testMode, client);
          }
        } else {
          active = startSession(data.canvas, data.testMode, client);
        }
        client.postMessage({ type: 'ready', rendererInfo: active.engine.rendererInfo, resumed });
        return;
      }
      if (data.type === 'release') {
        release(data.keepWarm);
        return;
      }
      if (!active) return;
      const session = active;
      const { canvas, engine } = session;
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
          if (active !== session) return;
          if (drawn && port) {
            const bitmap = canvas.transferToImageBitmap();
            response.bitmap = bitmap;
            client.postMessage(response, [bitmap]);
          } else {
            client.postMessage(response);
          }
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (data.type === 'frame' && active) {
        const { engine } = active;
        client.postMessage({
          type: 'frame', drawn: false, swapping: engine.isShaderSwapping(), progress: engine.getSwapProgress(),
          canPrefetch: engine.canPrefetch, quality: engine.qualityLevel, error: message,
        });
      } else {
        client.postMessage({ type: 'fatal', message });
      }
    }
  };
}

if ('onconnect' in scope) {
  scope.onconnect = ({ ports: [port] }) => connect(port, port);
} else {
  connect(scope);
}