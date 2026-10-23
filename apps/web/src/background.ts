import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import type {
  Track,
  LocalVideoTrack,
  VideoCaptureOptions,
  TrackProcessor,
  VideoProcessorOptions,
} from "livekit-client";

export type Background =
  | { mode: "none" }
  | { mode: "blur" }
  | { mode: "image"; image: string };
export const noBackground: Background = { mode: "none" };
type Owner = {
  signal?: AbortSignal;
  current?: () => boolean;
  onError?: () => void;
};
type Processor = TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & {
  switchTo: (background: Background) => Promise<void>;
};
const unavailable =
  "Background effects are unavailable in this browser. Select None to use the camera.";
const canceled = () => new DOMException("Camera stopped", "AbortError");
let supported: boolean | undefined;
export function supportsBackgroundProcessors() {
  if (typeof document === "undefined") return false;
  if (supported !== undefined) return supported;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  supported =
    typeof OffscreenCanvas !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof createImageBitmap !== "undefined" &&
    typeof canvas.captureStream === "function" &&
    !!gl;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return supported;
}

// Capture, segmentation and output share one cancelable owner.
export function backgroundProcessor(
  initial: Background,
  owner: Owner = {},
): Processor | undefined {
  if (initial.mode === "none") return undefined;
  let background: Background = initial;
  let destroyed = false;
  let run:
    | {
        source: MediaStreamTrack;
        video: HTMLVideoElement;
        canvas: HTMLCanvasElement;
        output: CanvasCaptureMediaStreamTrack;
        gpu: OffscreenCanvas;
        segmenter?: ImageSegmenter;
        mask: HTMLCanvasElement;
        foreground: HTMLCanvasElement;
        blur: HTMLCanvasElement;
        maskPixels?: ImageData;
        timer?: ReturnType<typeof setTimeout>;
        bitmap?: ImageBitmap;
        closed: boolean;
        changing: boolean;
        task?: Promise<void>;
        removeAbort: () => void;
        failed: () => void;
      }
    | undefined;
  type Run = NonNullable<typeof run>;
  const current = (active: Run) =>
    !destroyed &&
    run === active &&
    !active.closed &&
    !owner.signal?.aborted &&
    (owner.current?.() ?? true);
  const check = (active: Run) => {
    if (!current(active)) throw canceled();
  };
  function close(active: Run) {
    active.closed = true;
    clearTimeout(active.timer);
    active.removeAbort();
    active.source.stop();
    active.output.stop();
    active.video.pause();
    active.video.srcObject = null;
    active.canvas.width = active.canvas.height = 0;
  }
  async function release(active: Run) {
    close(active);
    const segmenter = active.segmenter;
    active.segmenter = undefined;
    try {
      segmenter?.close();
    } finally {
      active.mask.width = active.mask.height = 0;
      active.foreground.width = active.foreground.height = 0;
      active.blur.width = active.blur.height = 0;
      active.maskPixels = undefined;
      active.bitmap?.close();
      active.bitmap = undefined;
      active.gpu
        .getContext("webgl2")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
      active.gpu.width = active.gpu.height = 0;
    }
  }
  async function configure(active: Run, next: Background) {
    let bitmap: ImageBitmap | undefined;
    if (next.mode === "image") {
      const image = new Image();
      image.src = next.image;
      await image.decode();
      bitmap = await createImageBitmap(image);
    }
    try {
      check(active);
      active.bitmap?.close();
      active.bitmap = bitmap;
      bitmap = undefined;
      background = next;
    } finally {
      bitmap?.close();
    }
  }
  async function frame(active: Run) {
    check(active);
    if (
      active.source.readyState !== "live" ||
      !active.source.enabled ||
      active.video.readyState < 2 ||
      active.changing
    )
      return false;
    const { canvas, foreground, mask } = active;
    const video = new VideoFrame(active.video, {
      timestamp: Math.round(performance.now() * 1000),
    });
    try {
      const context = canvas.getContext("2d")!;
      if (background.mode === "none")
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      else {
        let segmented = false;
        active.segmenter!.segmentForVideo(
          video,
          performance.now(),
          (result) => {
            try {
              const category = result.categoryMask;
              if (!category)
                throw new Error("Background could not be applied. Try again.");
              if (
                !active.maskPixels ||
                mask.width !== category.width ||
                mask.height !== category.height
              ) {
                mask.width = category.width;
                mask.height = category.height;
                active.maskPixels = new ImageData(mask.width, mask.height);
              }
              const pixels = active.maskPixels.data,
                labels = category.getAsUint8Array();
              // This pinned model labels selfie as 0; unlabeled background is 255.
              for (let index = 0; index < labels.length; index++)
                pixels[index * 4 + 3] = labels[index] === 0 ? 255 : 0;
              mask.getContext("2d")!.putImageData(active.maskPixels, 0, 0);
              segmented = true;
            } finally {
              result.close();
            }
          },
        );
        check(active);
        if (!segmented)
          throw new Error("Background could not be applied. Try again.");
        const subject = foreground.getContext("2d")!;
        subject.clearRect(0, 0, canvas.width, canvas.height);
        subject.drawImage(video, 0, 0, canvas.width, canvas.height);
        subject.globalCompositeOperation = "destination-in";
        subject.filter = "blur(2px)";
        subject.drawImage(mask, 0, 0, canvas.width, canvas.height);
        subject.filter = "none";
        subject.globalCompositeOperation = "source-over";
        if (background.mode === "image") {
          const bitmap = active.bitmap!;
          const scale = Math.max(
            canvas.width / bitmap.width,
            canvas.height / bitmap.height,
          );
          const width = bitmap.width * scale,
            height = bitmap.height * scale;
          context.drawImage(
            bitmap,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height,
          );
        } else {
          const blurred = active.blur.getContext("2d")!;
          blurred.filter = "blur(3px)";
          blurred.drawImage(
            video,
            -6,
            -6,
            active.blur.width + 12,
            active.blur.height + 12,
          );
          blurred.filter = "none";
          context.drawImage(active.blur, 0, 0, canvas.width, canvas.height);
        }
        context.drawImage(foreground, 0, 0);
      }
      check(active);
      active.output.requestFrame();
      return true;
    } finally {
      video.close();
    }
  }
  function schedule(active: Run, delay = 1000 / 24) {
    active.timer = setTimeout(() => {
      if (!current(active)) {
        void release(active);
        return;
      }
      if (active.source.readyState !== "live") {
        void release(active);
        return;
      }
      if (active.changing) {
        schedule(active);
        return;
      }
      const started = performance.now();
      active.task = frame(active)
        .then(() => {
          if (current(active))
            schedule(
              active,
              Math.max(0, 1000 / 24 - (performance.now() - started)),
            );
        })
        .catch(() => {
          if (current(active)) active.failed();
          void release(active);
        });
    }, delay);
  }
  async function start(options: VideoProcessorOptions) {
    const source = options.track;
    try {
      if (destroyed || owner.signal?.aborted || !(owner.current?.() ?? true)) {
        source.stop();
        throw canceled();
      }
      if (!supportsBackgroundProcessors()) {
        source.stop();
        throw new Error(unavailable);
      }
      if (run) {
        const previous = run;
        close(previous);
        await previous.task?.catch(() => {});
        await release(previous);
      }
      let output: CanvasCaptureMediaStreamTrack | undefined;
      let gpu: OffscreenCanvas | undefined;
      let video: HTMLVideoElement;
      let canvas: HTMLCanvasElement;
      let mask: HTMLCanvasElement;
      let foreground: HTMLCanvasElement;
      let blur: HTMLCanvasElement;
      try {
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        canvas = document.createElement("canvas");
        const settings = source.getSettings();
        canvas.width = settings.width || 640;
        canvas.height = settings.height || 360;
        mask = document.createElement("canvas");
        foreground = document.createElement("canvas");
        foreground.width = canvas.width;
        foreground.height = canvas.height;
        blur = document.createElement("canvas");
        blur.width = Math.ceil(canvas.width / 4);
        blur.height = Math.ceil(canvas.height / 4);
        gpu = new OffscreenCanvas(canvas.width, canvas.height);
        output = canvas
          .captureStream(0)
          .getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
        if (!output || typeof output.requestFrame !== "function")
          throw new Error(unavailable);
      } catch (error) {
        source.stop();
        output?.stop();
        gpu
          ?.getContext("webgl2")
          ?.getExtension("WEBGL_lose_context")
          ?.loseContext();
        throw error;
      }
      const active: Run = {
        source,
        video,
        canvas,
        output,
        gpu,
        mask,
        foreground,
        blur,
        closed: false,
        changing: false,
        removeAbort() {},
        failed() {
          owner.onError?.();
          void options.localTrack?.mute().catch(() => {});
        },
      };
      run = active;
      const abort = () => {
        close(active);
      };
      owner.signal?.addEventListener("abort", abort, { once: true });
      active.removeAbort = () =>
        owner.signal?.removeEventListener("abort", abort);
      active.task = (async () => {
        try {
          if (typeof output.requestFrame !== "function")
            throw new Error(unavailable);
          video.srcObject = new MediaStream([source]);
          await video.play();
          check(active);
          const { FilesetResolver, ImageSegmenter } = await import(
            "@mediapipe/tasks-vision"
          );
          check(active);
          const files = await FilesetResolver.forVisionTasks(
            "/backgrounds/mediapipe-0.10.14",
          );
          check(active);
          active.segmenter = await ImageSegmenter.createFromOptions(files, {
            baseOptions: {
              modelAssetPath: "/backgrounds/selfie-segmenter-v1.tflite",
              delegate: "CPU",
            },
            canvas: active.gpu,
            runningMode: "VIDEO",
            outputCategoryMask: true,
            outputConfidenceMasks: false,
          });
          check(active);
          if (active.segmenter.getLabels().join(",") !== "selfie")
            throw new Error("Background could not be applied. Try again.");
          await configure(active, background);
          if (!(await frame(active))) throw canceled();
          check(active);
          processor.processedTrack = output;
          schedule(active);
        } catch (error) {
          await release(active).catch(() => {});
          throw error;
        }
      })();
      await active.task;
    } catch (error) {
      source.stop();
      throw error;
    }
  }
  const processor: Processor = {
    name: "covemeet-background",
    init: start,
    async restart(options) {
      try {
        await start(options);
      } catch (error) {
        if (
          !destroyed &&
          !owner.signal?.aborted &&
          (owner.current?.() ?? true)
        ) {
          owner.onError?.();
          void options.localTrack?.mute().catch(() => {});
        }
        throw error;
      }
    },
    async destroy() {
      destroyed = true;
      const active = run;
      if (!active) return;
      close(active);
      await active.task?.catch(() => {});
      await release(active);
      processor.processedTrack = undefined;
    },
    async switchTo(next) {
      const active = run;
      if (!active) throw canceled();
      check(active);
      active.changing = true;
      clearTimeout(active.timer);
      const context = active.canvas.getContext("2d")!;
      context.fillStyle = "black";
      context.fillRect(0, 0, active.canvas.width, active.canvas.height);
      active.output.requestFrame();
      await active.task;
      active.task = (async () => {
        try {
          await configure(active, next);
          active.changing = false;
          if (!(await frame(active))) throw canceled();
          schedule(active);
        } catch (error) {
          await release(active).catch(() => {});
          throw error;
        }
      })();
      await active.task;
    },
  };
  return processor;
}

export function cameraOptions(
  deviceId: string,
  background = noBackground,
  owner: Owner = {},
): VideoCaptureOptions {
  return {
    deviceId: deviceId ? { exact: deviceId } : "",
    processor: backgroundProcessor(background, owner),
  };
}

type CameraTrack = Pick<
  LocalVideoTrack,
  | "pauseUpstream"
  | "resumeUpstream"
  | "setProcessor"
  | "getProcessor"
  | "mute"
  | "isMuted"
  | "stop"
  | "mediaStreamTrack"
>;
// Stopping precedes fallible SDK cleanup, which otherwise can restore the raw sender.
export async function stopBackgroundCamera(
  track: CameraTrack,
  processor?: Processor,
) {
  try {
    track.stop();
  } catch {
    /* Continue cleanup if SDK teardown rejects. */
  }
  await Promise.allSettled([
    Promise.resolve().then(() => track.mute()),
    Promise.resolve().then(() => processor?.destroy()),
  ]);
}
export async function changeBackground(
  track: CameraTrack,
  background: Background,
  current: () => boolean,
  make = backgroundProcessor,
  signal?: AbortSignal,
  onError?: () => void,
) {
  let processor: Processor | undefined;
  const stop = () => {
    track.stop();
    void processor?.destroy();
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const output = track.mediaStreamTrack;
    const enabled = output.enabled;
    output.enabled = false;
    await track.pauseUpstream();
    if (signal?.aborted || !current()) {
      await stopBackgroundCamera(track);
      return false;
    }
    output.enabled = enabled;
    const existing = track.getProcessor() as Processor | undefined;
    if (existing?.name === "covemeet-background")
      await existing.switchTo(background);
    else {
      processor = make(background, { signal, current, onError });
      if (processor) await track.setProcessor(processor);
    }
    if (signal?.aborted || !current()) {
      await stopBackgroundCamera(track, processor);
      return false;
    }
    if (!track.isMuted) await track.resumeUpstream();
    if (signal?.aborted || !current()) {
      await stopBackgroundCamera(track, processor);
      return false;
    }
    return true;
  } catch (error) {
    await stopBackgroundCamera(track, processor);
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

export function validateBackgroundFile(file: Pick<File, "size" | "type">) {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a JPG, PNG or WebP image under 5 MB.");
}

// Read dimensions before asking the browser to allocate decoded pixels.
export function validateBackgroundDimensions(bytes: Uint8Array, type: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  let width = 0,
    height = 0;
  if (
    type === "image/png" &&
    bytes.length >= 24 &&
    text(1, 3) === "PNG" &&
    text(12, 4) === "IHDR"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 < bytes.length; ) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    type === "image/webp" &&
    text(0, 4) === "RIFF" &&
    text(8, 4) === "WEBP"
  ) {
    const chunk = text(12, 4);
    if (chunk === "VP8X" && bytes.length >= 30 && !(bytes[20] & 2)) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      text(23, 3) === "\x9d\x01\x2a"
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 47) {
      width = 1 + bytes[21] + ((bytes[22] & 63) << 8);
      height =
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10);
    }
  }
  if (!width || !height || width > 8192 || height > 8192)
    throw new Error("Choose an image no larger than 8192 × 8192 pixels.");
}

export async function readBackgroundImage(file: File): Promise<string> {
  validateBackgroundFile(file);
  validateBackgroundDimensions(
    new Uint8Array(await file.arrayBuffer()),
    file.type,
  );
  const image = await createImageBitmap(file);
  try {
    if (
      image.width > 8192 ||
      image.height > 8192 ||
      !image.width ||
      !image.height
    )
      throw new Error("Choose an image no larger than 8192 × 8192 pixels.");
    const scale = Math.min(1, 1920 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image processing is unavailable in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    image.close();
  }
}
