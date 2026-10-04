import { spawn } from "node:child_process";

const fields = {
  started: ["soundDevice", "audioSink"],
  tls: [
    "state",
    "verified",
    "allowedProtocols",
    "cipher",
    "verificationErrors",
  ],
  call: ["state", "status", "connected", "disconnected"],
  media: ["srtpActive", "srtpSuite"],
  stats: [
    "connected",
    "disconnected",
    "status",
    "tlsVerified",
    "tlsAllowedProtocols",
    "tlsCipher",
    "verificationErrors",
    "srtpActive",
    "srtpSuiteConfirmed",
    "receivedFrames",
    "nonSilentFrames",
    "peak",
    "generatedFrames",
    "rxPackets",
    "txPackets",
  ],
  command: ["operation", "accepted"],
  error: ["operation", "status"],
  "dtmf-drained": [],
  stopped: [],
};
const inheritedEnvironment = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "LD_LIBRARY_PATH",
  "SIP_PASSWORD_FILE",
  "SIP_CA_FILE",
  "SIP_TEST_HOST",
  "SIP_TEST_MODE",
  "SIP_DEADLINE_MS",
];

/** Native SIP process only. No browser, sound devices, or audio files. */
export class SipClient {
  #process;
  #events = [];
  #waiters = new Set();
  #nextSequence = 1;
  #failure;
  #closed;
  #closeResult;
  #commands = Promise.resolve();

  constructor({
    command = "/usr/local/bin/covemeet-sip-client",
    args = [],
    env = {},
  } = {}) {
    this.#process = spawn(command, args, {
      env: {
        ...Object.fromEntries(
          inheritedEnvironment
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        ),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = "";
    this.#closed = new Promise((resolve) => {
      this.#process.once("close", (code, signal) => {
        this.#closeResult = { code, signal };
        resolve(this.#closeResult);
        this.#rejectWaiters(
          new Error("SIP client exited before expected event"),
        );
      });
    });
    this.#process.once("error", () => this.#fail("SIP client could not start"));
    this.#process.stdin.on("error", () =>
      this.#fail("SIP client command pipe closed"),
    );
    // Native logs may contain SIP credentials or SRTP keys. Never retain or print them.
    this.#process.stderr.resume();
    this.#process.stdout.setEncoding("utf8");
    this.#process.stdout.on("data", (chunk) => {
      pending += chunk;
      if (pending.length > 65536)
        return this.#fail("SIP client output exceeded its bound");
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (
            !value ||
            typeof value !== "object" ||
            !Object.hasOwn(fields, value.event)
          )
            throw new Error();
          const event = { event: value.event, sequence: this.#nextSequence++ };
          for (const field of fields[value.event]) {
            const entry = value[field];
            if (!["string", "number", "boolean"].includes(typeof entry))
              throw new Error();
            if (
              typeof entry === "string" &&
              (entry.length > 80 || !/^[A-Za-z0-9_-]*$/.test(entry))
            )
              throw new Error();
            if (typeof entry === "number" && !Number.isSafeInteger(entry))
              throw new Error();
            event[field] = entry;
          }
          this.#events.push(Object.freeze(event));
          if (this.#events.length > 256) this.#events.shift();
          for (const waiter of [...this.#waiters]) waiter.check(event);
        } catch {
          this.#fail("SIP client returned invalid event metadata");
        }
      }
    });
  }

  get cursor() {
    return this.#nextSequence - 1;
  }
  get events() {
    return [...this.#events];
  }

  #rejectWaiters(error) {
    for (const waiter of [...this.#waiters]) waiter.reject(error);
  }
  #fail(message) {
    this.#failure ??= new Error(message);
    this.#rejectWaiters(this.#failure);
    this.#process.kill("SIGTERM");
  }
  #write(line) {
    if (this.#failure) throw this.#failure;
    if (this.#closeResult || !this.#process.stdin.writable)
      throw new Error("SIP client is not running");
    this.#process.stdin.write(`${line}\n`);
  }
  #serial(operation) {
    const result = this.#commands.then(operation);
    this.#commands = result.catch(() => {});
    return result;
  }

  waitFor(predicate, { after = 0, timeoutMs = 12000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      throw new Error("Invalid SIP event deadline");
    const present = this.#events.find(
      (event) => event.sequence > after && predicate(event),
    );
    if (present) return Promise.resolve(present);
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closeResult)
      return Promise.reject(new Error("SIP client has exited"));
    return new Promise((resolve, reject) => {
      const finish = (error, event) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        if (error) reject(error);
        else resolve(event);
      };
      const waiter = {
        check: (event) => {
          if (event.sequence > after && predicate(event))
            finish(undefined, event);
        },
        reject: (error) => finish(error),
      };
      const timer = setTimeout(
        () => finish(new Error("SIP event deadline exceeded")),
        timeoutMs,
      );
      this.#waiters.add(waiter);
    });
  }

  stats() {
    return this.#serial(() => {
      const after = this.cursor;
      this.#write("stats");
      return this.waitFor((event) => event.event === "stats", {
        after,
        timeoutMs: 3000,
      });
    });
  }

  tone(enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Invalid synthetic PCM state");
    return this.#serial(() => {
      const after = this.cursor;
      this.#write(enabled ? "tone on" : "tone off");
      return this.waitFor(
        (event) => event.event === "command" && event.operation === "tone",
        { after, timeoutMs: 3000 },
      );
    });
  }

  dtmf(digits) {
    if (typeof digits !== "string" || !/^[0-9*#]{1,32}$/.test(digits))
      throw new Error("Invalid DTMF input");
    return this.#serial(async () => {
      const after = this.cursor;
      this.#write(`dtmf ${digits}`);
      const accepted = await this.waitFor(
        (event) =>
          (event.event === "command" && event.operation === "dtmf") ||
          (event.event === "error" && event.operation.startsWith("dtmf-")),
        { after, timeoutMs: 3000 },
      );
      if (accepted.event === "error")
        throw new Error("SIP client rejected DTMF command");
      await this.waitFor((event) => event.event === "dtmf-drained", {
        after,
        timeoutMs: 15000,
      });
    });
  }

  async close() {
    if (!this.#closeResult) {
      try {
        this.#write("hangup");
      } catch {
        this.#process.kill("SIGTERM");
      }
    }
    const terminate = setTimeout(() => this.#process.kill("SIGTERM"), 3000);
    const kill = setTimeout(() => this.#process.kill("SIGKILL"), 5000);
    try {
      return await this.#closed;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
}
