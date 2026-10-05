import assert from "node:assert/strict";
import test from "node:test";
import { scheduledMeetingPending } from "../src/scheduled-status";

test("only missing hosted scheduled rooms use a credentialless portal status; failures retain core error", async () => {
  const config = {
      edition: "hosted" as const,
      portalOrigin: "https://covemeet.com",
    },
    code = "A".repeat(34),
    signal = new AbortController().signal;
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, `${config.portalOrigin}/api/schedules/status/${code}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.headers, undefined);
    return Response.json({ status: "not-started" });
  };
  for (const status of [0, 401, 403, 500])
    assert.equal(
      await scheduledMeetingPending(config, code, status, signal, fetcher),
      false,
    );
  assert.equal(
    await scheduledMeetingPending(
      { ...config, edition: "self-hosted" },
      code,
      404,
      signal,
      fetcher,
    ),
    false,
  );
  assert.equal(
    await scheduledMeetingPending(config, "invalid", 404, signal, fetcher),
    false,
  );
  assert.equal(calls, 0);
  assert.equal(
    await scheduledMeetingPending(config, code, 404, signal, fetcher),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(
    await scheduledMeetingPending(config, code, 404, signal, async () =>
      Response.json({ status: "unavailable" }),
    ),
    false,
  );
  assert.equal(
    await scheduledMeetingPending(config, code, 404, signal, async () => {
      throw new Error("offline");
    }),
    false,
  );
});
