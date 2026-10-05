import { setTimeout as delay } from "node:timers/promises";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

// Validation only: programmatic PCM and counter sinks. No device, playback,
// browser, audio file, or module-level resource ownership.
export async function bounded(promise, label, ms = 12_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function observe(room, identity) {
  const stats = { frames: 0, nonzeroFrames: 0, peak: 0 };
  const readers = new Map();
  const tasks = [];
  let stopped = false;
  let closing;
  const cancel = (sid) => {
    const reader = readers.get(sid);
    readers.delete(sid);
    void reader?.cancel().catch(() => {});
  };
  const subscribed = (track, publication, participant) => {
    if (
      stopped ||
      participant.identity !== identity() ||
      track.kind !== TrackKind.KIND_AUDIO ||
      !publication.sid
    )
      return;
    cancel(publication.sid);
    const reader = new AudioStream(track, {
      sampleRate: 48000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    readers.set(publication.sid, reader);
    tasks.push(
      (async () => {
        try {
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            let peak = 0;
            for (const sample of value.data)
              peak = Math.max(peak, Math.abs(sample));
            stats.frames++;
            if (peak > 32) stats.nonzeroFrames++;
            stats.peak = Math.max(stats.peak, peak);
          }
        } finally {
          await reader.cancel().catch(() => {});
          if (readers.get(publication.sid) === reader)
            readers.delete(publication.sid);
        }
      })().catch(() => {}),
    );
  };
  const unsubscribed = (_track, publication) => cancel(publication.sid);
  room.on(RoomEvent.TrackSubscribed, subscribed);
  room.on(RoomEvent.TrackUnsubscribed, unsubscribed);
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track)
        subscribed(publication.track, publication, participant);
    }
  }
  return {
    stats,
    close() {
      if (closing) return closing;
      stopped = true;
      room.off(RoomEvent.TrackSubscribed, subscribed);
      room.off(RoomEvent.TrackUnsubscribed, unsubscribed);
      closing = (async () => {
        await Promise.allSettled(
          [...readers.values()].map((reader) => reader.cancel()),
        );
        await Promise.allSettled(tasks);
        readers.clear();
      })();
      return closing;
    },
  };
}

export async function publish(room, frequency) {
  if (!Number.isFinite(frequency) || frequency < 40 || frequency > 4000) {
    throw new Error("Invalid synthetic PCM frequency");
  }
  const source = new AudioSource(48000, 1, 100);
  const track = LocalAudioTrack.createAudioTrack(
    "isolated-generated-pcm",
    source,
  );
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  try {
    await bounded(
      room.localParticipant.publishTrack(track, options),
      "synthetic audio publish",
    );
  } catch (error) {
    await track.close(true);
    throw error;
  }
  let stopping = false;
  let enabled = true;
  let sampleIndex = 0;
  let closing;
  const abort = new AbortController();
  const task = (async () => {
    while (!stopping) {
      const frame = AudioFrame.create(48000, 1, 960);
      for (let i = 0; i < frame.data.length; i++) {
        frame.data[i] = enabled
          ? Math.round(
              800 * Math.sin((2 * Math.PI * frequency * sampleIndex++) / 48000),
            )
          : 0;
      }
      await source.captureFrame(frame);
      await delay(20, undefined, { signal: abort.signal }).catch(() => {});
    }
  })().catch(() => {});
  return {
    setEnabled(value) {
      if (typeof value !== "boolean")
        throw new Error("Invalid synthetic PCM state");
      enabled = value;
      source.clearQueue();
    },
    close() {
      if (closing) return closing;
      stopping = true;
      abort.abort();
      source.clearQueue();
      closing = (async () => {
        await track.close(true);
        await task;
      })();
      return closing;
    },
  };
}
