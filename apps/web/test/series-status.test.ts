import assert from "node:assert/strict";
import test from "node:test";
import { recurringMeetingStatus, seriesCode, seriesJoinPath, seriesPollDelay } from "../src/series-status";
const config = { edition: "hosted" as const, portalOrigin: "https://covemeet.com" }, code = "A".repeat(34), room = "B".repeat(34);
const signal = () => new AbortController().signal;
test("series reads only the fixed portal without credentials and constructs a local guest path", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, `${config.portalOrigin}/api/schedule-series/resolve/${code}`);
    assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error"); assert.equal(init?.referrerPolicy, "no-referrer"); assert.equal(init?.headers, undefined);
    return Response.json({ status: "ready", code: room });
  };
  assert.equal(seriesCode(`/series/${code}/`), code);
  for (const path of [`/series/${code}?url=elsewhere`, `/series/${code}/extra`, "/series/%41", "/series/a", `/join/${code}`]) assert.equal(seriesCode(path), undefined);
  assert.equal(seriesJoinPath(await recurringMeetingStatus(config, code, signal(), fetcher)), `/join/${room}`);
  assert.deepEqual(await recurringMeetingStatus({ ...config, edition: "self-hosted" }, code, signal(), fetcher), { status: "unavailable" });
  assert.deepEqual(await recurringMeetingStatus(config, "../host", signal(), fetcher), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(seriesJoinPath({ status: "not-started", code: room }), undefined);
  assert.equal(seriesJoinPath({ status: "unavailable" }), undefined);
});
test("invalid redirects, host URLs, failed responses and late aborted results never become a join target", async () => {
  for (const data of [null, [], { status: "ready" }, { status: "ready", code: "https://evil.test/" }, { status: "ready", code: `../host/${room}` }, { status: "ready", code: room, hostUrl: "private" }, { status: "not-started", brandingProfileId: "javascript:bad" }, { status: "unavailable", code: room }])
    assert.deepEqual(await recurringMeetingStatus(config, code, signal(), async () => Response.json(data)), { status: "unavailable" });
  for (const status of [401, 403, 404]) assert.deepEqual(await recurringMeetingStatus(config, code, signal(), async () => Response.json({ status: "ready", code: room }, { status })), { status: "unavailable" });
  assert.deepEqual(await recurringMeetingStatus(config, code, signal(), async () => new Response("x".repeat(16385))), { status: "retry" });
  const controller = new AbortController();
  const pending = recurringMeetingStatus(config, code, controller.signal, async () => { controller.abort(); return Response.json({ status: "ready", code: room }); });
  assert.deepEqual(await pending, { status: "unavailable" });
  assert.equal(seriesJoinPath({ status: "ready", code: "javascript:bad" }), undefined);
});

test("pending, rate-limited and interrupted lookups keep retrying without a target, then recover to the current room", async () => {
  const replies = [Response.json({ status: "not-started" }), Response.json({ status: "ready", code: room }, { status: 429 }), Response.json({ status: "ready", code: room })];
  const fetcher: typeof fetch = async () => replies.shift()!;
  const pending = await recurringMeetingStatus(config, code, signal(), fetcher);
  assert.equal(seriesPollDelay(pending), 15000);
  assert.equal(seriesJoinPath(pending), undefined);
  const throttled = await recurringMeetingStatus(config, code, signal(), fetcher);
  assert.deepEqual(throttled, { status: "retry" });
  assert.equal(seriesJoinPath(throttled), undefined);
  assert.equal(seriesPollDelay(throttled, 1), 20000);
  assert.equal(seriesPollDelay(throttled, 2), 40000);
  assert.equal(seriesPollDelay(throttled, 20, 3000), 60000);
  const ready = await recurringMeetingStatus(config, code, signal(), fetcher);
  assert.equal(seriesJoinPath(ready), `/join/${room}`); assert.equal(seriesPollDelay(ready), undefined);
  for (const status of [408, 500, 502, 503]) assert.deepEqual(await recurringMeetingStatus(config, code, signal(), async () => Response.json({ status: "unavailable" }, { status })), { status: "retry" });
  assert.deepEqual(await recurringMeetingStatus(config, code, signal(), async () => { throw new TypeError("CORS or offline"); }), { status: "retry" });
  assert.equal(seriesPollDelay({ status: "unavailable" }), undefined);
});
