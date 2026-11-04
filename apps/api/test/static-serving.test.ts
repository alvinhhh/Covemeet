import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore } from "../src/store.js";

async function files(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "covemeet-static-"));
  const root = join(directory, "public");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "backgrounds"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Static fixture</title>");
  await writeFile(join(root, "assets", "app.js"), "export const fixture = true;\n");
  await writeFile(join(root, "assets", "app.css"), "body { color: black; }\n");
  await writeFile(join(root, "backgrounds", "vision.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(join(root, "backgrounds", "model.tflite"), "model fixture");
  await writeFile(join(directory, "private.txt"), "outside-static-root");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return root;
}

test("application static assets retain GET, HEAD, MIME, routing and traversal boundaries", async (t) => {
  const root = await files(t);
  const config = loadConfig({
    NODE_ENV: "test",
    STATIC_DIR: root,
    SESSION_SECRET: "static-serving-session-secret-at-least-32-characters",
    LIVEKIT_API_KEY: "static-fixture",
    LIVEKIT_API_SECRET: "static-serving-media-secret-at-least-32-characters",
    RECORDING_ENABLED: "false",
  });
  const store = new MemoryStore();
  const app = await createApp(config, store, new LiveMedia(config, store));
  t.after(() => app.close());
  for (const [url, mime] of [
    ["/assets/app.js", /(?:text|application)\/javascript/],
    ["/assets/app.css", /text\/css/],
    ["/backgrounds/vision.wasm", /application\/wasm/],
    ["/backgrounds/model.tflite", /application\/octet-stream/],
  ] as const) {
    const get = await app.inject({ method: "GET", url });
    assert.equal(get.statusCode, 200, url);
    assert.match(String(get.headers["content-type"]), mime, url);
    assert.ok(get.rawPayload.length > 0, url);
    const head = await app.inject({ method: "HEAD", url });
    assert.equal(head.statusCode, 200, url);
    assert.equal(head.payload, "", url);
    assert.equal(head.headers["content-type"], get.headers["content-type"], url);
    assert.equal(head.headers["content-length"], get.headers["content-length"], url);
  }
  const missingApi = await app.inject("/api/not-a-route");
  assert.equal(missingApi.statusCode, 404);
  assert.deepEqual(missingApi.json(), { error: "Not found" });
  const route = await app.inject("/join/not-a-real-meeting");
  assert.equal(route.statusCode, 200);
  assert.match(route.payload, /<title>Static fixture<\/title>/);
  for (const url of ["/assets/%2e%2e/%2e%2e/private.txt", "/..%2fprivate.txt"]) {
    const denied = await app.inject(url);
    assert.doesNotMatch(denied.payload, /outside-static-root/);
    if (denied.statusCode === 200) {
      assert.equal(denied.payload, "<!doctype html><title>Static fixture</title>", url);
      assert.match(String(denied.headers["content-type"]), /text\/html/);
    } else
      assert.ok([400, 403, 404].includes(denied.statusCode), `${url}: ${denied.statusCode}`);
  }
});

test("static file enumeration preserves nested paths, dot selection, ignored paths and symlinks", async (t) => {
  const root = await files(t);
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "nested", "file.txt"), "nested fixture");
  await writeFile(join(root, ".hidden.txt"), "dot fixture");
  await writeFile(join(root, "ignored", "file.txt"), "ignored fixture");
  await symlink("nested", join(root, "linked"));
  for (const serveDotFiles of [false, true]) {
    const app = Fastify();
    t.after(() => app.close());
    await app.register(staticFiles, {
      root,
      prefix: "/files/",
      wildcard: false,
      index: false,
      serveDotFiles,
      globIgnore: ["**/ignored/**"],
    });
    for (const url of ["/files/nested/file.txt", "/files/linked/file.txt"]) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.payload, "nested fixture");
    }
    const dot = await app.inject("/files/.hidden.txt");
    assert.equal(dot.statusCode, serveDotFiles ? 200 : 404);
    if (serveDotFiles) assert.equal(dot.payload, "dot fixture");
    for (const url of ["/files/ignored/file.txt", "/files/missing.txt", "/files/nested/"])
      assert.equal((await app.inject(url)).statusCode, 404, url);
  }
});
