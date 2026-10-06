import assert from "node:assert/strict";
import test from "node:test";
import { routeBranding } from "../src/team-branding";
import { publicJson } from "../src/scheduled-status";

const config = {
  edition: "hosted" as const,
  portalOrigin: "https://covemeet.com",
};
const id = "76fc7904-7a53-4e69-ac37-2ef64a9a6e8f";
const brand = {
  brandName: "Example team",
  headline: "Meetings",
  description: "",
  accentColor: "#171717",
  backgroundColor: "#ffffff",
  font: "sans",
  borderRadius: "rounded",
  showHostButton: true,
  logoUrl: `${config.portalOrigin}/api/public/team-assets/${id}/logo/${"a".repeat(64)}`,
};
const profile = { id, slug: "example", revision: 1, branding: brand };
const code = "ABC123".repeat(4) + "DE";
const signal = () => new AbortController().signal;

test("company lookup and meeting lookup use only the fixed portal and stored meeting profile", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.headers, undefined);
    return Response.json(
      String(url).startsWith("/api/meetings/")
        ? { brandingProfileId: id }
        : { profile },
    );
  };
  assert.equal(
    (await routeBranding(config, "/t/example", signal(), fetcher))?.brandName,
    brand.brandName,
  );
  assert.deepEqual(calls, [
    `${config.portalOrigin}/api/public/team-pages/example`,
  ]);
  calls.length = 0;
  assert.equal(
    (await routeBranding(config, `/join/${code}`, signal(), fetcher))?.logoUrl,
    brand.logoUrl,
  );
  assert.deepEqual(calls, [
    `/api/meetings/${code}/branding`,
    `${config.portalOrigin}/api/public/team-branding/${id}`,
  ]);
  for (const path of [`/recordings/${code}`, `/download/${code}`]) {
    calls.length = 0;
    assert.equal(
      (await routeBranding(config, path, signal(), fetcher))?.brandName,
      brand.brandName,
    );
    assert.deepEqual(calls, [
      `/api/meetings/${code}/branding`,
      `${config.portalOrigin}/api/public/team-branding/${id}`,
    ]);
  }
  calls.length = 0;
  for (const path of [
    "/",
    "/branding",
    "/t/evil%2fpath",
    `/join/${code}?team=example`,
    `/recordings/${code}?team=example`,
  ])
    assert.equal(
      await routeBranding(config, path, signal(), fetcher),
      undefined,
    );
  assert.equal(
    await routeBranding(
      { ...config, edition: "self-hosted" },
      "/t/example",
      signal(),
      fetcher,
    ),
    undefined,
  );
  assert.equal(calls.length, 0);
});

test("only a missing scheduled meeting may load its saved pre-start profile", async () => {
  const scheduledCode = "A".repeat(34);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("/api/meetings/"))
      return new Response(null, { status: 404 });
    return Response.json(
      String(url).includes("/schedules/status/")
        ? { status: "not-started", brandingProfileId: id }
        : { profile },
    );
  };
  assert.equal(
    (await routeBranding(config, `/join/${scheduledCode}`, signal(), fetcher))
      ?.brandName,
    brand.brandName,
  );
  assert.deepEqual(calls, [
    `/api/meetings/${scheduledCode}/branding`,
    `${config.portalOrigin}/api/schedules/status/${scheduledCode}`,
    `${config.portalOrigin}/api/public/team-branding/${id}`,
  ]);
  assert.equal(
    await routeBranding(config, `/join/${code}`, signal(), async () =>
      Response.json({ brandingProfileId: null }),
    ),
    undefined,
  );
});

test("unpublished, malformed, foreign assets and stale requests fail neutral", async () => {
  for (const replacement of [
    null,
    {
      ...profile,
      branding: { ...brand, logoUrl: "https://elsewhere.test/logo.png" },
    },
    {
      ...profile,
      branding: { ...brand, backgroundUrl: "data:image/svg+xml,bad" },
    },
    {
      ...profile,
      branding: {
        ...brand,
        accentColor: "red; background:url(https://elsewhere.test)",
      },
    },
    { ...profile, branding: { ...brand, supportUrl: "javascript:alert(1)" } },
  ])
    assert.equal(
      await routeBranding(config, "/t/example", signal(), async () =>
        Response.json({ profile: replacement }),
      ),
      undefined,
    );
  assert.equal(
    await routeBranding(
      config,
      "/t/example",
      signal(),
      async () => new Response(null, { status: 404 }),
    ),
    undefined,
  );
  assert.equal(
    await routeBranding(config, `/join/${code}`, signal(), async (url) =>
      Response.json(
        String(url).startsWith("/api/")
          ? { brandingProfileId: id }
          : {
              profile: {
                ...profile,
                id: "00000000-0000-4000-8000-000000000000",
              },
            },
      ),
    ),
    undefined,
  );
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  const pending = routeBranding(
    config,
    "/t/example",
    controller.signal,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  controller.abort();
  resolve(Response.json({ profile }));
  assert.equal(await pending, undefined);
  assert.deepEqual(
    await publicJson(
      "/api/unused",
      signal(),
      async () => new Response("x".repeat(16385)),
    ),
    { status: 0 },
  );
});
