import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { STSClient } from "@aws-sdk/client-sts";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { createServer, type Socket } from "node:net";
import { loadMailConfig } from "../src/config.js";
import { MailBudgetExhausted } from "../src/budget.js";
import {
  createMailTransport,
  type MailBudget,
  type SesDependencies,
} from "../src/transport.js";

const env = {
  MAIL_TRANSPORT: "ses",
  SES_REGION: "us-east-2",
  SES_ACCOUNT_ID: "123456789012",
  SES_ROLE_ARN: "arn:aws:iam::123456789012:role/mail/Sender",
  MAIL_DATABASE_URL: "postgres://mail:fixture@localhost/mail_test",
  AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
};
const config = loadMailConfig(env, {
  defaultFrom: "Sender <sender@example.test>",
  defaultPort: 1025,
});
const message = {
  from: config.smtpFrom,
  to: "recipient@example.test",
  subject: "Fixture",
  text: "Synthetic",
};
const temporary = (id = "temporary-one") => ({
  accessKeyId: id,
  secretAccessKey: "fixture-secret",
  sessionToken: "fixture-session",
  expiration: new Date(Date.now() + 600_000),
});
const identity = {
  Account: "123456789012",
  Arn: "arn:aws:sts::123456789012:assumed-role/Sender/i-fixture",
};

function fixture() {
  const events: string[] = [];
  const snapshots: Parameters<SesDependencies["clients"]>[0][] = [];
  const rawMessages: string[] = [];
  let credentials = temporary();
  let caller = identity;
  let failSend = false;
  const budget: MailBudget = {
    async reserve({ accountId, region, signal }) {
      signal.throwIfAborted();
      assert.equal(accountId, identity.Account);
      assert.equal(region, "us-east-2");
      events.push("reserve");
    },
    async close() {},
  };
  const deps: SesDependencies = {
    environment: () => env,
    async credentials() {
      events.push("credentials");
      return credentials;
    },
    clients(snapshot, region) {
      assert.equal(region, "us-east-2");
      snapshots.push(snapshot);
      return {
        async identity(signal) {
          signal.throwIfAborted();
          events.push("identity");
          return caller;
        },
        async send(command, signal) {
          signal.throwIfAborted();
          events.push("send");
          assert.deepEqual(command.input.Destination, {
            ToAddresses: [message.to],
          });
          assert.equal(command.input.FromEmailAddress, config.smtpFrom);
          assert.ok(command.input.Content?.Raw?.Data);
          rawMessages.push(
            Buffer.from(command.input.Content!.Raw!.Data!).toString("utf8"),
          );
          if (failSend) throw new Error("private raw SDK failure");
          return { MessageId: "fixture-message" };
        },
        close() {
          events.push("close");
        },
      };
    },
  };
  return {
    events,
    snapshots,
    rawMessages,
    budget,
    deps,
    setCredentials(value: typeof credentials) {
      credentials = value;
    },
    setIdentity(value: typeof identity) {
      caller = value;
    },
    fail() {
      failSend = true;
    },
  };
}

test("SES invitation capacity rejection remains identifiable before dispatch", async () => {
  const f = fixture();
  f.budget.reserve = async ({ deliveryClass }) => {
    assert.equal(deliveryClass, "invitation");
    throw new MailBudgetExhausted();
  };
  const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
  try {
    await assert.rejects(
      mail.sendMail({ ...message, deliveryClass: "invitation" }),
      MailBudgetExhausted,
    );
    assert.equal(f.events.includes("send"), false);
  } finally {
    await mail.close();
  }
});

test("each SES send binds one temporary credential snapshot and rechecks rotated identity", async () => {
  const f = fixture();
  const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
  assert.deepEqual(f.events, []);
  const result = await mail.sendMail(message);
  assert.deepEqual(Object.keys(result), ["messageId"]);
  assert.deepEqual(f.events, [
    "credentials",
    "identity",
    "reserve",
    "send",
    "close",
  ]);
  // Exercise the installed SDK credential resolution without network calls.
  // Both clients add source metadata to the captured credential object.
  const keys = { ...f.snapshots[0]! };
  for (const Client of [STSClient, SESv2Client]) {
    const client = new Client({
      credentials: f.snapshots[0]!,
      region: "us-east-2",
    });
    try {
      const resolved = await client.config.credentials();
      for (const [key, value] of Object.entries(keys))
        assert.deepEqual(resolved[key as keyof typeof resolved], value);
    } finally {
      client.destroy();
    }
  }
  f.events.length = 0;
  f.setCredentials(temporary("temporary-two"));
  f.setIdentity({
    ...identity,
    Arn: "arn:aws:sts::123456789012:assumed-role/Other/i-fixture",
  });
  await assert.rejects(
    mail.sendMail(message),
    /Mail delivery was not confirmed/,
  );
  assert.deepEqual(f.events, ["credentials", "identity", "close"]);
  assert.equal(f.snapshots[1]?.accessKeyId, "temporary-two");
  await mail.close();
});

test("SES rejects credential fallback, expired original credentials and wrong accounts before budget/send", async () => {
  assert.throws(() => createMailTransport(config), /shared durable/);
  for (const mutation of [
    (f: ReturnType<typeof fixture>) =>
      f.setIdentity({ ...identity, Account: "999999999999" }),
    (f: ReturnType<typeof fixture>) =>
      f.setIdentity({ ...identity, Arn: `${identity.Arn}/bad` }),
    (f: ReturnType<typeof fixture>) => {
      f.deps.credentials = async () => ({
        ...temporary(),
        originalExpiration: new Date(0),
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.deps.credentials = async () => ({
        ...temporary(),
        sessionToken: undefined,
      });
    },
  ]) {
    const f = fixture();
    mutation(f);
    const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
    await assert.rejects(mail.sendMail(message));
    assert.equal(f.events.includes("reserve"), false);
    assert.equal(f.events.includes("send"), false);
    await mail.close();
  }
  const f = fixture();
  f.deps.environment = () => ({
    ...env,
    AWS_ACCESS_KEY_ID: "old-static-identity",
  });
  assert.throws(
    () => createMailTransport(config, { budget: f.budget }, f.deps),
    /instance credentials/,
  );
});

test("single-recipient envelope and supported content are checked before any AWS operation", async () => {
  const f = fixture();
  const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
  for (const extra of [
    { to: "one@example.test,two@example.test" },
    { to: ["one@example.test"] },
    { cc: "hidden@example.test" },
    { envelope: { from: "other@example.test", to: message.to } },
    { from: "other@example.test" },
    { raw: "fixture" },
    { messageId: "<safe@example.test>\r\nBcc: hidden@example.test" },
    { icalEvent: { content: "fixture", path: "/tmp/private" } },
    { icalEvent: { content: "fixture", filename: "../private.ics" } },
  ])
    await assert.rejects(mail.sendMail({ ...message, ...extra }));
  assert.deepEqual(f.events, []);
  await mail.sendMail({
    ...message,
    icalEvent: {
      method: "REQUEST",
      content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    },
  });
  await mail.close();
});

test("existing Teams and schedule payloads preserve Message-ID and inline calendar MIME", async () => {
  const f = fixture();
  const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
  const attemptId = "0d809685-b12a-482b-a10d-c0510219d2bb";
  await mail.sendMail({
    ...message,
    messageId: `<team-${attemptId}@covemeet.io>`,
    subject: "Team invitation",
  });
  await mail.sendMail({
    ...message,
    messageId: `<meeting-${attemptId}@covemeet.io>`,
    subject: "Meeting invitation: Fixture",
    icalEvent: {
      filename: "meeting.ics",
      method: "REQUEST",
      content:
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n",
    },
  });
  assert.match(
    f.rawMessages[0]!,
    /Message-ID: <team-0d809685-b12a-482b-a10d-c0510219d2bb@covemeet.io>/,
  );
  assert.match(
    f.rawMessages[1]!,
    /Message-ID: <meeting-0d809685-b12a-482b-a10d-c0510219d2bb@covemeet.io>/,
  );
  assert.match(f.rawMessages[1]!, /Content-Type: multipart\/mixed/);
  assert.match(
    f.rawMessages[1]!,
    /Content-Type: text\/calendar; charset=utf-8; method=REQUEST/,
  );
  assert.match(f.rawMessages[1]!, /filename=meeting\.ics/);
  await mail.close();
});

test("ambiguous SES failure is not retried or refunded and exposes no provider detail", async () => {
  const f = fixture();
  f.fail();
  const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
  await assert.rejects(
    mail.sendMail(message),
    (error: Error) =>
      error.message === "Mail delivery was not confirmed" && !error.cause,
  );
  assert.equal(f.events.filter((event) => event === "send").length, 1);
  assert.equal(f.events.filter((event) => event === "reserve").length, 1);
  await mail.close();
});

test("shutdown aborts waiting budget and late IMDS resolution cannot dispatch", async () => {
  for (const phase of ["credentials", "reserve"] as const) {
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: ReturnType<typeof temporary>) => void;
    if (phase === "credentials")
      f.deps.credentials = () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      };
    else
      f.budget.reserve = ({ signal }) =>
        new Promise((_, reject) => {
          entered();
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
    const mail = createMailTransport(config, { budget: f.budget }, f.deps)!;
    const sent = mail.sendMail(message);
    const rejected = assert.rejects(sent, /Mail delivery was not confirmed/);
    await ready;
    await mail.close();
    release?.(temporary());
    await rejected;
    assert.equal(f.events.includes("send"), false);
    await assert.rejects(mail.sendMail(message), /closed/);
  }
});

test("SMTP retains verified TLS and uses the same bounded message contract", async (t) => {
  let closed = false;
  t.mock.method(
    nodemailer,
    "createTransport",
    (options: Record<string, unknown>) => {
      assert.equal(options.requireTLS, true);
      assert.deepEqual(options.tls, {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      });
      assert.equal(options.socketTimeout, 10_000);
      return {
        async sendMail() {
          return { messageId: "smtp-fixture", response: "private" };
        },
        close() {
          closed = true;
        },
      };
    },
  );
  const mail = createMailTransport({
    ...config,
    mailTransport: "smtp",
    smtpHost: "localhost",
    production: true,
  })!;
  assert.deepEqual(await mail.sendMail(message), { messageId: "smtp-fixture" });
  await mail.close();
  assert.equal(closed, true);
});

for (const tlsHandshake of [false, true])
  test(`SMTP shutdown destroys the stalled ${tlsHandshake ? "TLS handshake" : "greeting"} socket`, async () => {
    let accepted: Socket | undefined;
    let connected!: () => void;
    const connectionReady = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let socketClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      socketClosed = resolve;
    });
    const server = createServer((socket) => {
      accepted = socket;
      socket.on("error", () => {});
      socket.once("close", socketClosed);
      if (!tlsHandshake) return connected();
      let stage = "ehlo";
      let input = "";
      socket.write("220 fixture ESMTP\r\n");
      socket.on("data", (chunk) => {
        if (stage === "tls") return connected();
        input += chunk.toString("utf8");
        if (!input.includes("\r\n")) return;
        if (stage === "ehlo" && input.startsWith("EHLO ")) {
          stage = "starttls";
          socket.write("250-fixture\r\n250 STARTTLS\r\n");
        } else if (stage === "starttls" && input.startsWith("STARTTLS\r\n")) {
          stage = "tls";
          socket.write("220 Ready for TLS\r\n");
        }
        input = "";
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const mail = createMailTransport({
      ...config,
      mailTransport: "smtp",
      production: tlsHandshake,
      smtpHost: "127.0.0.1",
      smtpPort: address.port,
    })!;
    try {
      const sent = mail.sendMail(message);
      const rejected = assert.rejects(sent, /Mail delivery was not confirmed/);
      await Promise.race([
        connectionReady,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("SMTP fixture handshake did not start")),
            1500,
          );
          timer.unref();
        }),
      ]);
      await mail.close();
      await rejected;
      await Promise.race([
        connectionClosed,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("SMTP socket remained open")),
            1000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      await mail.close();
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
