import sharedWorkerUrl from './webgl.worker?sharedworker&url';
import type { FractalParams } from '../types/fractal';

export type WebGLWorkerRequest =
  | { type: 'init'; canvas: OffscreenCanvas; testMode: boolean }
  | { type: 'attach'; width: number; height: number; testMode: boolean }
  | { type: 'release'; keepWarm: boolean }
  | { type: 'frame'; time: number; params: FractalParams; width: number; height: number; capture: boolean }
  | { type: 'quality'; level: number }
  | { type: 'prefetch'; index: number };

export type WebGLWorkerResponse =
  | { type: 'ready'; rendererInfo: string; resumed: boolean }
  | { type: 'progress'; stage: string; percent: number }
  | { type: 'fatal'; message: string }
  | { type: 'frame'; drawn: boolean; swapping: boolean; progress: number; canPrefetch: boolean; quality: number; bitmap?: ImageBitmap; screenshot?: Blob; error?: string };

function openResumableWorker(): SharedWorker | undefined {
  if (typeof SharedWorker === 'undefined' || typeof ImageBitmapRenderingContext === 'undefined') return;
  try {
    const key = 'swype.webgl.session';
    const name = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, name);
    let supportsLifetime = false;
    const options = {
      name,
      type: 'module' as const,
      get extendedLifetime() {
        supportsLifetime = true;
        return true;
      },
    };
    const worker = new SharedWorker(sharedWorkerUrl, options);
    if (supportsLifetime) return worker;
    worker.port.close();
  } catch {
    // Storage or shared workers may be unavailable in an embedded document.
  }
}

/**
 * One request at a time, with camera and layout sampled again on the next frame.
 * The canvas and the GPU context belong to the worker for their whole lifetime.
 */
export class WorkerWebGLEngine {
  readonly canvas: HTMLCanvasElement;
  rendererInfo = 'WebGL2 Shader Pipeline';
  qualityLevel = 2;
  width: number;
  height: number;
  frameIntervalMs = 0;
  onCompileProgress?: (stage: string, percent: number) => void;

  private worker: Worker | SharedWorker;
  private channel: Worker | MessagePort;
  private readonly shared: boolean;
  private presentation?: ImageBitmapRenderingContext;
  private leaving = false;
  get leavingDocument() { return this.leaving; }
  private detachPortListeners?: () => void;
  private onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      this.leaving = true;
      this.close(true);
      return;
    }
    // Chrome evicts a cached document if its shared worker posts to it.
    // Keep the last presented frame and the React state in the cached page.
    this.ready = false;
    this.waitingForFrame = false;
    this.drawn = false;
    this.lastDrawAt = 0;
    this.frameIntervalMs = 0;
    clearTimeout(this.initTimer);
    this.releasePort(true);
  };
  private onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || this.closed) return;
    const worker = openResumableWorker();
    if (!worker) {
      this.fail('Could not reconnect to the WebGL worker');
      return;
    }
    this.worker = worker;
    this.channel = worker.port;
    this.listen();
    this.initTimer = setTimeout(() => this.fail('WebGL worker reconnection timed out'), 15000);
    this.attach();
  };
  private ready = false;
  private closed = false;
  private waitingForFrame = false;
  private drawn = false;
  private swapping = false;
  private swapProgress = 0;
  private prefetchReady = false;
  private lastDrawAt = 0;
  private frameError?: string;
  private screenshotCallback?: (url: string) => void;
  private screenshotReading = false;
  private finishInit?: (ok: boolean) => void;
  private initTimer?: ReturnType<typeof setTimeout>;

  constructor(canvas: HTMLCanvasElement, private readonly onFailure: (message: string) => void) {
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    const shared = openResumableWorker();
    const worker = shared ?? new Worker(new URL('./webgl.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.shared = !!shared;
    this.channel = shared?.port ?? (worker as Worker);
    this.listen();
  }

  private listen() {
    const channel = this.channel;
    const worker = this.worker;
    let listening = true;
    const current = () => listening && !this.closed && this.channel === channel;
    channel.onmessage = ({ data }: MessageEvent<WebGLWorkerResponse>) => {
      if (current()) this.receive(data);
      else if (data.type === 'frame') data.bitmap?.close();
    };
    worker.onerror = event => {
      if (current()) this.fail(event.message || 'WebGL worker failed to load');
    };
    channel.onmessageerror = () => {
      if (current()) this.fail('WebGL worker message could not be decoded');
    };
    if (this.shared) {
      const port = channel as MessagePort;
      const onClose = () => {
        if (current()) this.fail('WebGL worker connection closed');
      };
      port.addEventListener('close', onClose, { once: true });
      this.detachPortListeners = () => {
        listening = false;
        worker.onerror = null;
        port.onmessage = null;
        port.onmessageerror = null;
        port.removeEventListener('close', onClose);
      };
    }
  }

  init(): Promise<boolean> {
    return new Promise(resolve => {
      this.finishInit = resolve;
      try {
        const testMode = window.location.search.includes('test=1');
        this.initTimer = setTimeout(() => this.fail('WebGL worker initialization timed out'), 15000);
        if (this.shared) {
          const presentation = this.canvas.getContext('bitmaprenderer');
          if (!presentation) throw new Error('Image bitmap presentation is unavailable');
          this.presentation = presentation;
          window.addEventListener('pagehide', this.onPageHide);
          window.addEventListener('pageshow', this.onPageShow);
          this.attach();
        } else {
          const canvas = this.canvas.transferControlToOffscreen();
          this.send({ type: 'init', canvas, testMode }, [canvas]);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private attach() {
    this.send({
      type: 'attach', width: this.width, height: this.height,
      testMode: window.location.search.includes('test=1'),
    });
    this.send({ type: 'quality', level: this.qualityLevel });
  }

  private releasePort(keepWarm: boolean) {
    const port = this.channel as MessagePort;
    this.detachPortListeners?.();
    this.detachPortListeners = undefined;
    port.postMessage({ type: 'release', keepWarm } satisfies WebGLWorkerRequest);
    port.close();
  }

  private send(message: WebGLWorkerRequest, transfer: Transferable[] = []) {
    if (!this.closed) this.channel.postMessage(message, transfer);
  }

  private receive(message: WebGLWorkerResponse) {
    if (this.closed) {
      if (message.type === 'frame') message.bitmap?.close();
      return;
    }
    switch (message.type) {
      case 'ready':
        this.rendererInfo = message.rendererInfo;
        this.ready = true;
        clearTimeout(this.initTimer);
        this.finishInit?.(true);
        this.finishInit = undefined;
        break;
      case 'progress':
        this.onCompileProgress?.(message.stage, message.percent);
        break;
      case 'fatal':
        this.fail(message.message);
        break;
      case 'frame':
        this.waitingForFrame = false;
        if (message.bitmap && this.presentation) {
          const { width, height } = message.bitmap;
          if (this.canvas.width !== width) this.canvas.width = width;
          if (this.canvas.height !== height) this.canvas.height = height;
          this.presentation.transferFromImageBitmap(message.bitmap);
        }
        this.drawn = message.drawn;
        this.swapping = message.swapping;
        this.swapProgress = message.progress;
        this.prefetchReady = message.canPrefetch;
        this.qualityLevel = message.quality;
        this.frameError = message.error;
        if (message.drawn) {
          const now = performance.now();
          this.frameIntervalMs = this.lastDrawAt ? now - this.lastDrawAt : 0;
          this.lastDrawAt = now;
        }
        if (message.screenshot && this.screenshotCallback) {
          const callback = this.screenshotCallback;
          this.screenshotCallback = undefined;
          this.screenshotReading = true;
          const reader = new FileReader();
          reader.onloadend = () => {
            if (!this.closed && typeof reader.result === 'string') callback(reader.result);
            this.screenshotReading = false;
          };
          reader.readAsDataURL(message.screenshot);
        }
        break;
    }
  }

  private fail(message: string) {
    if (this.closed) return;
    const initializing = !!this.finishInit;
    this.destroy();
    if (!initializing) this.onFailure(message);
  }

  render(time: number, params: FractalParams): boolean {
    const error = this.frameError;
    this.frameError = undefined;
    if (error) throw new Error(error);
    const drewFrame = this.drawn;
    this.drawn = false;
    if (this.ready && !this.waitingForFrame && !this.closed) {
      this.waitingForFrame = true;
      this.send({
        type: 'frame', time, params, width: this.width, height: this.height,
        capture: !!this.screenshotCallback,
      });
    }
    return drewFrame;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setQualityLevel(level: number) {
    this.qualityLevel = Math.max(0, Math.min(2, level));
    this.send({ type: 'quality', level: this.qualityLevel });
  }

  get canPrefetch() { return this.prefetchReady; }
  prefetchFractal(index: number) { this.send({ type: 'prefetch', index }); }
  isShaderSwapping() { return this.swapping; }
  getSwapProgress() { return this.swapProgress; }

  requestScreenshot(callback: (url: string) => void) {
    if (!this.screenshotCallback && !this.screenshotReading) this.screenshotCallback = callback;
  }

  destroy() {
    this.close(false);
  }

  private close(keepWarm: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.initTimer);
    this.finishInit?.(false);
    this.finishInit = undefined;
    if (this.shared) {
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
      this.releasePort(keepWarm);
    } else {
      (this.worker as Worker).terminate();
    }
  }
}
