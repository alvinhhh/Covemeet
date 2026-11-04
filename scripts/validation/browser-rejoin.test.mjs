import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Protocol debug logs can contain private invitations and session cookies.
delete process.env.DEBUG;
delete process.env.PWDEBUG;
const { chromium } = await import("playwright-core");

const base = new URL(process.env.BASE_URL || "http://invalid");
assert.ok(
  ["http:", "https:"].includes(base.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    base.pathname === "/",
  "BASE_URL must be a bare loopback HTTP(S) origin",
);
assert.ok(
  process.env.BROWSER_EXECUTABLE,
  "Set BROWSER_EXECUTABLE to installed Chromium or Chrome",
);
const creationKey = process.env.BROWSER_REJOIN_CREATION_KEY_FILE
  ? (
      await readFile(process.env.BROWSER_REJOIN_CREATION_KEY_FILE, "utf8")
    ).trim()
  : process.env.BROWSER_REJOIN_CREATION_KEY;
assert.ok(
  creationKey?.length >= 32,
  "A private fixture creation key is required",
);

test(
  "a departed guest can request fresh admission without bypassing meeting controls",
  { timeout: 90000 },
  async (t) => {
    const suffix = randomBytes(6).toString("hex");
    const title = `Browser rejoin ${suffix}`;
    const guestName = `Guest ${suffix}`;
    const password = randomBytes(18).toString("hex");
    let browser, hostContext, owned, hostCookie, hostSession;
    let stage = "browser startup",
      captureCalls = 0;
    const checks = [];
    const path = (tail) =>
      `/api/meetings/${encodeURIComponent(owned.code)}${tail}`;
    async function until(check, milliseconds = 12000) {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(100, undefined, { signal: t.signal });
      }
      throw new Error("condition timed out");
    }
    async function request(method, endpoint, body, cookie) {
      const response = await fetch(new URL(endpoint, base), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Origin: base.origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body
            ? {
                "Content-Type": "application/json",
                "X-Requested-With": "MeetingPlatform",
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        data: await response.json(),
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; "),
      };
    }
    async function pageRequest(page, method, tail, body) {
      return page.evaluate(
        async ({ endpoint, method, body }) => {
          const response = await fetch(endpoint, {
            method,
            headers: body
              ? {
                  "Content-Type": "application/json",
                  "X-Requested-With": "MeetingPlatform",
                }
              : {},
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          return { status: response.status, data: await response.json() };
        },
        { endpoint: path(tail), method, body },
      );
    }
    t.after(async () => {
      let cleanupFailed = false;
      try {
        if (owned) {
          if (hostSession) hostCookie = (await hostSession).cookie;
          let state = await request(
            "GET",
            path("/state"),
            undefined,
            hostCookie,
          );
          if (state.status !== 200) {
            const exchanged = await request("POST", path("/host"), {
              token: owned.hostToken,
            });
            hostCookie = exchanged.cookie;
            state = await request("GET", path("/state"), undefined, hostCookie);
          }
          assert.equal(state.status, 200);
          assert.equal(state.data.meeting.code, owned.code);
          assert.equal(state.data.meeting.title, title);
          assert.equal(state.data.me.role, "host");
          if (!state.data.meeting.ended || state.data.meeting.cleanupPending) {
            const ended = await request("POST", path("/end"), {}, hostCookie);
            assert.ok([200, 202].includes(ended.status));
          }
          const deadline = Date.now() + 10000;
          do {
            state = await request("GET", path("/state"), undefined, hostCookie);
            if (state.data.meeting?.ended && !state.data.meeting.cleanupPending)
              break;
            await delay(200);
          } while (Date.now() < deadline);
          assert.equal(state.data.meeting?.ended, true);
          assert.equal(state.data.meeting.cleanupPending, false);
        }
      } catch {
        cleanupFailed = true;
      } finally {
        await browser?.close();
      }
      assert.equal(
        cleanupFailed,
        false,
        "Owned meeting cleanup was not confirmed",
      );
      assert.equal(
        captureCalls,
        0,
        "The UI attempted device or screen capture",
      );
    });
    try {
      browser = await chromium.launch({
        executablePath: process.env.BROWSER_EXECUTABLE,
        headless: true,
        chromiumSandbox: true,
        args: ["--mute-audio"],
        env: Object.fromEntries(
          ["PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR"]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
      });
      t.signal.addEventListener(
        "abort",
        () => {
          void browser.close();
        },
        { once: true },
      );
      async function context() {
        const context = await browser.newContext({
          permissions: [],
          serviceWorkers: "block",
        });
        await context.exposeBinding("captureAttempt", () => {
          captureCalls += 1;
        });
        await context.addInitScript(() => {
          for (const name of ["getUserMedia", "getDisplayMedia"])
            if (navigator.mediaDevices)
              Object.defineProperty(navigator.mediaDevices, name, {
                value: async () => {
                  await window.captureAttempt();
                  throw new DOMException(
                    "Capture disabled for this test",
                    "NotAllowedError",
                  );
                },
              });
          HTMLMediaElement.prototype.play = async function () {
            this.muted = true;
          };
        });
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === base.origin
            ? route.continue()
            : route.abort(),
        );
        const socketOrigin = base.origin.replace(/^http/, "ws");
        await context.routeWebSocket(/.*/, (route) => {
          const url = new URL(route.url());
          if (url.origin === socketOrigin && !url.username && !url.password) {
            route.connectToServer();
            return;
          }
          return route.close({ code: 1008, reason: "Outside fixture origin" });
        });
        context.setDefaultTimeout(10000);
        return context;
      }
      hostContext = await context();
      const guestContext = await context();
      const host = await hostContext.newPage(),
        guest = await guestContext.newPage();
      const config = await request("GET", "/api/config");
      assert.equal(config.status, 200);
      assert.equal(config.data.edition, "self-hosted");
      assert.equal(new URL(config.data.meetingOrigin).origin, base.origin);
      stage = "owned meeting creation";
      const created = await request("POST", "/api/meetings", {
        title,
        hostName: "Test host",
        password,
        mode: "meeting",
        creationKey,
      });
      assert.equal(created.status, 200);
      owned = created.data;
      assert.match(owned.code, /^[A-Z0-9]{6,48}$/);
      const invitation = new URL(`/join/${owned.code}`, base).href;
      assert.equal(owned.guestUrl, invitation);
      // Keep cleanup authority independent of browser lifetime and navigation.
      stage = "host capability exchange";
      hostSession = request("POST", path("/host"), { token: owned.hostToken });
      const exchanged = await hostSession;
      hostCookie = exchanged.cookie;
      assert.equal(exchanged.status, 200);
      assert.ok(hostCookie);
      stage = "host session installation";
      await hostContext.addCookies(
        hostCookie.split("; ").map((cookie) => {
          const separator = cookie.indexOf("=");
          return {
            name: cookie.slice(0, separator),
            value: cookie.slice(separator + 1),
            url: base.origin,
            httpOnly: true,
            secure: base.protocol === "https:",
            sameSite: "Strict",
          };
        }),
      );
      stage = "host navigation";
      await host.goto(new URL(`/meet/${owned.code}`, base).href);
      stage = "host toolbar";
      await host
        .getByRole("button", { name: "Leave meeting", exact: true })
        .waitFor();
      await host.getByRole("button", { name: "More", exact: true }).click();
      stage = "host participants panel";
      await host
        .getByRole("button", { name: "Participants", exact: true })
        .click();
      await host.locator(".meeting-panel").waitFor();
      checks.push("host opens Participants through More");
      stage = "guest invitation";
      await guest.goto(invitation);
      async function fillAdmission() {
        await guest.getByLabel("Display name", { exact: true }).fill(guestName);
        await guest
          .getByLabel("Meeting password", { exact: true })
          .fill(password);
      }
      async function admit() {
        await host
          .locator(".participant-row")
          .filter({ hasText: guestName })
          .getByRole("button", { name: "Admit", exact: true })
          .click();
        await guest
          .getByRole("button", { name: "Leave meeting", exact: true })
          .waitFor();
      }
      stage = "initial admission";
      await fillAdmission();
      await guest
        .getByRole("button", { name: "Request to join", exact: true })
        .click();
      await admit();
      const admitted = (await pageRequest(guest, "GET", "/state")).data;
      assert.equal(admitted.me.role, "participant");
      stage = "voluntary leave and original invitation";
      await guest
        .getByRole("button", { name: "Leave meeting", exact: true })
        .click();
      await guest
        .getByRole("heading", { name: "You left the meeting", exact: true })
        .waitFor();
      const departedCookies = await guestContext.cookies(base.origin);
      await guest.goto(invitation);
      await guest
        .getByRole("button", { name: "Request admission", exact: true })
        .click();
      await fillAdmission();
      let realPolls = 0;
      const observed = (response) => {
        if (
          new URL(response.url()).pathname === path("/state") &&
          response.status() === 200
        )
          realPolls += 1;
      };
      guest.on("response", observed);
      await until(() => realPolls >= 3);
      guest.off("response", observed);
      assert.equal(
        await guest.getByLabel("Display name", { exact: true }).inputValue(),
        guestName,
      );
      checks.push("left guest form survives three actual state polls");
      stage = "stale state response";
      const left = (await pageRequest(guest, "GET", "/state")).data;
      assert.ok(left.revision > admitted.revision);
      let staleDelivered = false;
      const stateUrl = new URL(path("/state"), base).href;
      await guest.route(
        stateUrl,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(admitted),
          });
          staleDelivered = true;
        },
        { times: 1 },
      );
      await until(() => staleDelivered);
      await guest.waitForResponse(
        async (response) =>
          response.url() === stateUrl &&
          response.status() === 200 &&
          (await response.json()).revision >= left.revision,
      );
      assert.equal(
        await guest.getByLabel("Display name", { exact: true }).inputValue(),
        guestName,
      );
      checks.push("rejected older state cannot discard form input");
      stage = "locked meeting refusal";
      await host
        .getByRole("button", { name: "Lock meeting", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Unlock meeting", exact: true })
        .waitFor();
      const refused = guest.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === path("/join") &&
          r.request().method() === "POST",
      );
      await guest
        .getByRole("button", { name: "Request to join", exact: true })
        .click();
      assert.equal((await refused).status(), 403);
      await guest.getByText("Meeting is locked", { exact: true }).waitFor();
      await host
        .getByRole("button", { name: "Unlock meeting", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Lock meeting", exact: true })
        .waitFor();
      stage = "fresh waiting session";
      await guest
        .getByRole("button", { name: "Request to join", exact: true })
        .click();
      await guest
        .getByText("The host will admit you when the meeting is ready.", {
          exact: true,
        })
        .waitFor();
      const waiting = (await pageRequest(guest, "GET", "/state")).data;
      assert.equal(waiting.me.status, "waiting");
      assert.equal(waiting.me.role, "participant");
      assert.notEqual(waiting.me.id, admitted.me.id);
      const waitingMedia = await pageRequest(guest, "POST", "/media", {});
      assert.equal(waitingMedia.status, 403);
      assert.equal(waitingMedia.data.error, "Media is unavailable in this room");
      checks.push("locked join and waiting media requests return 403");
      stage = "host readmission";
      await admit();
      const returned = (await pageRequest(guest, "GET", "/state")).data;
      assert.equal(returned.me.id, waiting.me.id);
      assert.equal(returned.me.role, "participant");
      assert.equal(returned.me.moderator, false);
      assert.equal(captureCalls, 0);
      checks.push("host readmits ordinary guest without capture");
      stage = "ban and meeting end";
      await host
        .getByRole("button", { name: `Controls for ${guestName}`, exact: true })
        .click();
      await host
        .getByRole("button", { name: "Ban from meeting…", exact: true })
        .click();
      await host
        .getByRole("button", { name: "Ban participant", exact: true })
        .click();
      await guest
        .getByRole("heading", { name: "Meeting access removed", exact: true })
        .waitFor();
      assert.equal(
        await guest
          .getByRole("button", { name: "Request admission", exact: true })
          .count(),
        0,
      );
      const bannedJoin = await pageRequest(guest, "POST", "/join", {
        name: guestName,
        password,
      });
      assert.equal(bannedJoin.status, 403);
      assert.equal(bannedJoin.data.error, "Entry is blocked for this meeting");
      const departedContext = await context();
      await departedContext.addCookies(departedCookies);
      const departed = await departedContext.newPage();
      await departed.goto(invitation);
      await departed
        .getByRole("button", { name: "Request admission", exact: true })
        .waitFor();
      const terminal = (await pageRequest(departed, "GET", "/state")).data;
      assert.equal(terminal.me.id, admitted.me.id);
      assert.equal(terminal.me.status, "left");
      assert.equal(terminal.meeting.ended, false);
      await host
        .getByRole("button", { name: "Leave meeting", exact: true })
        .click();
      host.once("dialog", (dialog) => void dialog.accept());
      await host
        .getByRole("button", { name: "End for everyone", exact: true })
        .click();
      await guest
        .getByRole("heading", { name: "Meeting ended", exact: true })
        .waitFor();
      await departed
        .getByRole("heading", { name: "Meeting ended", exact: true })
        .waitFor();
      assert.equal(
        await guest
          .getByRole("button", { name: "Request admission", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await departed
          .getByRole("button", { name: "Request admission", exact: true })
          .count(),
        0,
      );
      checks.push("banned and ended sessions expose no admission action");
      t.diagnostic(
        JSON.stringify({ browser: browser.version(), checks, captureCalls }),
      );
    } catch (error) {
      t.diagnostic(
        JSON.stringify({ stage, browser: browser?.version(), checks, captureCalls }),
      );
      // Retain locator and assertion details without invitations or credentials.
      let detail = String(error?.message ?? error);
      for (const secret of [
        creationKey,
        password,
        owned?.hostToken,
        owned?.code,
        hostCookie,
      ])
        if (secret) detail = detail.split(secret).join("[redacted]");
      detail = detail
        .replace(/https?:\/\/[^\s"'<>]+/g, "[fixture URL]")
        .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted token]");
      throw new Error(
        `Browser rejoin regression failed during ${stage}: ${detail.slice(0, 8000)}`,
      );
    }
  },
);
