import assert from "node:assert/strict";
import test from "node:test";
import { loadMailConfig } from "../src/config.js";
import { createMailTransport, type MailBudget } from "../src/transport.js";
import { MailBudgetExhausted } from "../src/budget.js";

const config = loadMailConfig(
  {
    MAIL_TRANSPORT: "twilio-email",
    TWILIO_EMAIL_ACCOUNT_SID: "AC" + "a".repeat(32),
    TWILIO_EMAIL_API_KEY_SID: "SK" + "b".repeat(32),
    TWILIO_EMAIL_API_KEY_SECRET: "c".repeat(32),
    MAIL_DATABASE_URL: "postgres://mail:fixture@localhost/mail_test",
  },
  { defaultFrom: "Covemeet <meetings@example.test>", defaultPort: 1025 },
);
const operationId = "comms_operation_01h9krwprkeee8fzqspvwy6nq8";
const message = {
  to: "recipient@example.test",
  subject: "Meeting invitation",
  text: 'A < B & "C"',
};

test("Twilio Email sends bounded JSON with scoped budget, Basic API key auth and escaped plain text", async (t) => {
  const events: string[] = [];
  const budget: MailBudget = {
    async reserve({ accountId, region, signal }) {
      assert.equal(accountId, config.twilioEmail!.accountId);
      assert.equal(region, "twilio-email");
      signal.throwIfAborted();
      events.push("reserve");
    },
    async close() {},
  };
  assert.throws(() => createMailTransport(config), /shared durable/);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    events.push("send");
    assert.equal(url, "https://comms.twilio.com/v1/Emails");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(
      headers.get("authorization"),
      `Basic ${Buffer.from(`${config.twilioEmail!.apiKeySid}:${config.twilioEmail!.apiKeySecret}`).toString("base64")}`,
    );
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body as string), {
      from: { address: "meetings@example.test", name: "Covemeet" },
      to: [
        {
          address: message.to,
          variables: {
            subject: message.subject,
            text: message.text,
            html: "<pre>A &lt; B &amp; &quot;C&quot;</pre>",
          },
        },
      ],
      content: {
        subject: "{{ subject | default: 'Covemeet message' }}",
        text: "{{ text | default: 'Message unavailable.' }}",
        html: "{{ html | default: 'Message unavailable.' }}",
      },
    });
    return Response.json({ operationId }, { status: 202 });
  });
  const mail = createMailTransport(config, { budget })!;
  assert.deepEqual(await mail.sendMail(message), { messageId: operationId });
  assert.deepEqual(events, ["reserve", "send"]);
  await mail.close();
});

test("Twilio Email preserves supplied HTML, Message-ID and calendar request/cancellation bytes", async (t) => {
  const bodies: any[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ operationId }, { status: 202 });
    },
  );
  const mail = createMailTransport(config, {
    budget: { async reserve() {}, async close() {} },
  })!;
  for (const method of ["REQUEST", "CANCEL"]) {
    const content = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nEND:VCALENDAR\r\n`;
    const messageId = `<meeting-fixture-${method}@example.test>`;
    await mail.sendMail({
      ...message,
      html: "<p>Meeting</p>",
      messageId,
      icalEvent: { filename: "meeting.ics", method, content },
    });
    const sent = bodies.at(-1).content;
    assert.equal(sent.html, "{{ html | default: 'Message unavailable.' }}");
    assert.equal(bodies.at(-1).to[0].variables.html, "<p>Meeting</p>");
    assert.deepEqual(sent.headers, { "Message-ID": messageId });
    assert.equal(sent.attachments.length, 1);
    assert.deepEqual(sent.attachments[0], {
      filename: "meeting.ics",
      contentType: `text/calendar; charset=utf-8; method=${method}`,
      content: Buffer.from(content).toString("base64"),
    });
  }
  await mail.close();
});

test("Twilio Email defaults every template variable, keeps user content literal and cancels oversized responses", async (t) => {
  const input = {
    ...message,
    subject: "{{ missing }} {% invalid %}",
    text: "{% if broken",
    html: "<p>{{ untouched }}</p>",
  };
  let cancelled = false,
    sends = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      sends++;
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.to[0].variables, {
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      assert.deepEqual(body.content, {
        subject: "{{ subject | default: 'Covemeet message' }}",
        text: "{{ text | default: 'Message unavailable.' }}",
        html: "{{ html | default: 'Message unavailable.' }}",
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 202 },
      );
    },
  );
  const mail = createMailTransport(config, {
    budget: { async reserve() {}, async close() {} },
  })!;
  await assert.rejects(mail.sendMail(input), /Mail delivery was not confirmed/);
  assert.equal(cancelled, true);
  assert.equal(sends, 1);
  await mail.close();
});

test("Twilio Email rejects recipient/header/attachment overrides and oversize input before dispatch", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("unexpected fetch");
  });
  const mail = createMailTransport(config, {
    budget: {
      async reserve() {
        calls++;
      },
      async close() {},
    },
  })!;
  for (const extra of [
    { to: "one@example.test,two@example.test" },
    { cc: "other@example.test" },
    { from: "other@example.test" },
    { subject: "fixture\r\nBcc: other@example.test" },
    { messageId: "<fixture@example.test>\r\nBcc: other@example.test" },
    { text: "x".repeat(256 * 1024 + 1) },
    { icalEvent: { content: "fixture", path: "/tmp/private" } },
  ])
    await assert.rejects(
      mail.sendMail({ ...message, ...extra }),
      /Invalid mail message/,
    );
  assert.equal(calls, 0);
  await mail.close();
});

test("invitation capacity rejection is identifiable before Twilio dispatch", async (t) => {
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    throw new Error("unexpected provider call");
  });
  const mail = createMailTransport(config, {
    budget: {
      async reserve({ deliveryClass }) {
        assert.equal(deliveryClass, "invitation");
        throw new MailBudgetExhausted();
      },
      async close() {},
    },
  })!;
  try {
    await assert.rejects(
      mail.sendMail({ ...message, deliveryClass: "invitation" }),
      MailBudgetExhausted,
    );
    assert.equal(sends, 0);
  } finally {
    await mail.close();
  }
});

test("Twilio Email never retries or refunds ambiguous sends and sanitizes provider responses", async (t) => {
  let sends = 0,
    reservations = 0;
  const responses = [
    new Response("private provider detail", { status: 401 }),
    Response.json({ operationId }, { status: 200 }),
    Response.json({ operationId: "private invalid id" }, { status: 202 }),
    new Response("not JSON", { status: 202 }),
  ];
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    return responses.shift()!;
  });
  const mail = createMailTransport(config, {
    budget: {
      async reserve() {
        reservations++;
      },
      async close() {},
    },
  })!;
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      mail.sendMail(message),
      (error: Error) =>
        error.message === "Mail delivery was not confirmed" && !error.cause,
    );
  assert.equal(sends, 4);
  assert.equal(reservations, 4);
  await mail.close();
});

test("Twilio Email shutdown aborts pending budget and in-flight HTTP without a late send", async (t) => {
  for (const phase of ["budget", "http"] as const) {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sends = 0;
    const wait = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        entered();
        signal.addEventListener(
          "abort",
          () => reject(new Error("private aborted request")),
          { once: true },
        );
      });
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init: RequestInit) => {
        sends++;
        return wait(init.signal!);
      },
    );
    const mail = createMailTransport(config, {
      budget: {
        async reserve({ signal }) {
          if (phase === "budget") await wait(signal);
        },
        async close() {},
      },
    })!;
    const sent = assert.rejects(
      mail.sendMail(message),
      /Mail delivery was not confirmed/,
    );
    await ready;
    await mail.close();
    await sent;
    assert.equal(sends, phase === "budget" ? 0 : 1);
    await assert.rejects(mail.sendMail(message), /closed/);
    fetchMock.mock.restore();
  }
});
