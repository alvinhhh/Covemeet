/** Bounded real-time queue. Drop old audio rather than accumulating delayed speech. */
export class FrameQueue<T> {
  private frames: T[] = [];
  constructor(private capacity = 3) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10)
      throw new Error("Invalid frame queue size");
  }
  push(frame: T) {
    this.frames.push(frame);
    while (this.frames.length > this.capacity) this.frames.shift();
  }
  shift() {
    return this.frames.shift();
  }
  clear() {
    this.frames = [];
  }
  get size() {
    return this.frames.length;
  }
}
