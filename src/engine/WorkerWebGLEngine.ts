import type { FractalParams } from '../types/fractal';

export type WebGLWorkerRequest =
  | { type: 'init'; canvas: OffscreenCanvas; testMode: boolean }
  | { type: 'frame'; time: number; params: FractalParams; width: number; height: number; capture: boolean }
  | { type: 'quality'; level: number }
  | { type: 'prefetch'; index: number };

export type WebGLWorkerResponse =
  | { type: 'ready'; rendererInfo: string }
  | { type: 'progress'; stage: string; percent: number }
  | { type: 'fatal'; message: string }
  | { type: 'frame'; drawn: boolean; swapping: boolean; progress: number; canPrefetch: boolean; quality: number; screenshot?: Blob; error?: string };

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

  private worker: Worker;
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
    this.worker = new Worker(new URL('./webgl.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WebGLWorkerResponse>) => this.receive(event.data);
    this.worker.onerror = event => this.fail(event.message || 'WebGL worker failed to load');
    this.worker.onmessageerror = () => this.fail('WebGL worker message could not be decoded');
  }

  init(): Promise<boolean> {
    return new Promise(resolve => {
      this.finishInit = resolve;
      try {
        const canvas = this.canvas.transferControlToOffscreen();
        this.initTimer = setTimeout(() => this.fail('WebGL worker initialization timed out'), 15000);
        this.send({ type: 'init', canvas, testMode: window.location.search.includes('test=1') }, [canvas]);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private send(message: WebGLWorkerRequest, transfer: Transferable[] = []) {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  private receive(message: WebGLWorkerResponse) {
    if (this.closed) return;
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
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.initTimer);
    this.finishInit?.(false);
    this.finishInit = undefined;
    this.worker.terminate();
  }
}
