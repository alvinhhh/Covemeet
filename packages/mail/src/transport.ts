import nodemailer, { type SendMailOptions } from "nodemailer";
import { createConnection, type Socket } from "node:net";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromInstanceMetadata } from "@smithy/credential-provider-imds";
import {
  assertInstanceEnvironment,
  hasMail,
  mailbox,
  type MailConfig,
} from "./config.js";

export interface MailBudget {
  reserve(input: {
    accountId: string;
    region: string;
    signal: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface MailTransport {
  sendMail(message: SendMailOptions): Promise<{ messageId?: string }>;
  close(): Promise<void>;
}

type Credentials = Awaited<ReturnType<ReturnType<typeof fromInstanceMetadata>>>;
type SesClients = {
  identity(signal: AbortSignal): Promise<{ Account?: string; Arn?: string }>;
  send(
    command: SendEmailCommand,
    signal: AbortSignal,
  ): Promise<{ MessageId?: string }>;
  close(): void;
};

// Explicit dependencies keep security regressions entirely offline.
export interface SesDependencies {
  credentials(): Promise<Credentials>;
  clients(credentials: Credentials, region: string): SesClients;
  environment(): NodeJS.ProcessEnv;
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const SEND_DEADLINE_MS = 30_000;
const SDK_DEADLINE_MS = 10_000;

function dependencies(): SesDependencies {
  return {
    credentials: fromInstanceMetadata({
      ec2MetadataV1Disabled: true,
      timeout: 1000,
      maxRetries: 0,
      logger: silentLogger,
    }),
    environment: () => process.env,
    clients(credentials, region) {
      const config = {
        credentials,
        region,
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        logger: silentLogger,
      };
      const sts = new STSClient(config);
      const ses = new SESv2Client(config);
      return {
        identity: (abortSignal) =>
          sts.send(new GetCallerIdentityCommand({}), { abortSignal }),
        send: (command, abortSignal) => ses.send(command, { abortSignal }),
        close() {
          sts.destroy();
          ses.destroy();
        },
      };
    },
  };
}

function messageFor(
  config: MailConfig,
  message: SendMailOptions,
): SendMailOptions {
  // All product mail is text/HTML with an optional in-memory calendar event.
  // Exclude envelope, raw MIME, URL/file attachments and caller SES overrides.
  const allowed = new Set([
    "from",
    "to",
    "subject",
    "messageId",
    "text",
    "html",
    "icalEvent",
  ]);
  if (
    Object.keys(message).some((key) => !allowed.has(key)) ||
    (message.from !== undefined && message.from !== config.smtpFrom) ||
    typeof message.subject !== "string" ||
    /[\r\n]/.test(message.subject) ||
    (message.messageId !== undefined &&
      (typeof message.messageId !== "string" ||
        !/^<[A-Za-z0-9][A-Za-z0-9._+-]{0,199}@[A-Za-z0-9.-]{1,253}>$/.test(
          message.messageId,
        ))) ||
    (message.text !== undefined && typeof message.text !== "string") ||
    (message.html !== undefined && typeof message.html !== "string")
  )
    throw new Error("Unsupported mail message");
  const to = mailbox(message.to);
  const event = message.icalEvent;
  let calendar = "";
  if (event !== undefined) {
    if (
      !event ||
      typeof event !== "object" ||
      Object.keys(event).some(
        (key) => !["method", "content", "filename"].includes(key),
      ) ||
      ("filename" in event && event.filename !== "meeting.ics") ||
      !("content" in event) ||
      typeof event.content !== "string" ||
      ("method" in event &&
        (typeof event.method !== "string" || !/^[A-Z]+$/i.test(event.method)))
    )
      throw new Error("Invalid calendar mail");
    calendar = event.content;
  }
  if (
    Buffer.byteLength(
      [message.subject, message.text ?? "", message.html ?? "", calendar].join(
        "",
      ),
    ) >
    256 * 1024
  )
    throw new Error("Mail message is too large");
  return { ...message, from: config.smtpFrom, to };
}

function snapshot(value: Credentials): Credentials {
  const expiration =
    value.originalExpiration && value.expiration
      ? new Date(
          Math.min(
            value.originalExpiration.getTime(),
            value.expiration.getTime(),
          ),
        )
      : value.expiration;
  if (
    !value.accessKeyId ||
    !value.secretAccessKey ||
    !value.sessionToken ||
    !(expiration instanceof Date) ||
    !Number.isFinite(expiration.getTime()) ||
    expiration.getTime() <= Date.now() + SEND_DEADLINE_MS
  )
    throw new Error("Fresh temporary instance credentials are required");
  // Keep a separate snapshot; the AWS SDK adds credential-source metadata.
  return {
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    sessionToken: value.sessionToken,
    expiration: new Date(expiration.getTime()),
  };
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Mail operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function sendSmtp(
  config: MailConfig,
  mail: SendMailOptions,
  signal: AbortSignal,
) {
  let socket: Socket | undefined;
  const sender = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: config.production,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: config.smtpUser
      ? { user: config.smtpUser, pass: config.smtpPass }
      : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    // Non-pooled Nodemailer.close() does not close an active SMTP connection.
    // Own its underlying socket; Nodemailer still performs SMTP and verified TLS.
    getSocket(_options, callback) {
      if (signal.aborted)
        return callback(new Error("Mail operation aborted"), false);
      const connection = createConnection({
        host: config.smtpHost,
        port: config.smtpPort,
        signal,
      });
      socket = connection;
      let handedOff = false;
      const finish = (error?: Error) => {
        if (handedOff) return;
        handedOff = true;
        callback(error ?? null, error ? false : { connection });
      };
      connection.on("error", finish);
      connection.setTimeout(5000, () =>
        connection.destroy(new Error("Mail connection timeout")),
      );
      connection.once("connect", () => {
        connection.setTimeout(0);
        if (signal.aborted)
          connection.destroy(new Error("Mail operation aborted"));
        else finish();
      });
    },
  });
  try {
    return await abortable(sender.sendMail(mail), signal);
  } finally {
    socket?.destroy();
    sender.close();
  }
}

async function sendTwilioEmail(
  config: MailConfig,
  mail: SendMailOptions,
  budget: MailBudget,
  signal: AbortSignal,
): Promise<{ messageId: string }> {
  const credentials = config.twilioEmail!;
  const text = mail.text as string | undefined;
  // Twilio requires HTML. Preserve plain-text-only mail without interpreting it.
  const html =
    (mail.html as string | undefined) ??
    `<pre>${(text ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!,
    )}</pre>`;
  const event = mail.icalEvent as
    | { content: string; method?: string; filename?: string }
    | undefined;
  const from = mailbox(config.smtpFrom);
  const name = config.smtpFrom.match(/^([^<>]*)</)?.[1]?.trim();
  const body = JSON.stringify({
    from: { address: from, name: name || from },
    to: [
      {
        address: mail.to,
        variables: { subject: mail.subject, text: text ?? "", html },
      },
    ],
    content: {
      // Keep user content out of the provider's Liquid template source.
      // Twilio rejects templates when any variable lacks a default filter.
      subject: "{{ subject | default: 'Covemeet message' }}",
      text: "{{ text | default: 'Message unavailable.' }}",
      html: "{{ html | default: 'Message unavailable.' }}",
      ...(mail.messageId ? { headers: { "Message-ID": mail.messageId } } : {}),
      ...(event
        ? {
            attachments: [
              {
                filename: "meeting.ics",
                contentType: `text/calendar; charset=utf-8; method=${(event.method ?? "PUBLISH").toUpperCase()}`,
                content: Buffer.from(event.content, "utf8").toString("base64"),
              },
            ],
          }
        : {}),
    },
  });
  if (Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("Mail message is too large");
  await abortable(
    budget.reserve({
      accountId: credentials.accountId,
      region: "twilio-email",
      signal,
    }),
    signal,
  );
  signal.throwIfAborted();
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(SDK_DEADLINE_MS),
  ]);
  const response = await abortable(
    fetch("https://comms.twilio.com/v1/Emails", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.apiKeySid}:${credentials.apiKeySecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: requestSignal,
    }),
    requestSignal,
  );
  if (response.status !== 202) {
    await response.body?.cancel();
    throw new Error("Mail was not accepted");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Mail acceptance was not confirmed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), requestSignal);
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) throw new Error("Mail provider response too large");
      chunks.push(part.value);
    }
  } catch {
    await abortable(reader.cancel(), requestSignal).catch(() => {});
    throw new Error("Mail acceptance was not confirmed");
  } finally {
    reader.releaseLock();
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !result ||
    typeof result !== "object" ||
    !("operationId" in result) ||
    typeof result.operationId !== "string" ||
    !/^comms_operation_[0-7][a-hjkmnpqrstv-z0-9]{25,34}$/.test(
      result.operationId,
    )
  )
    throw new Error("Mail acceptance was not confirmed");
  return { messageId: result.operationId };
}

export function createMailTransport(
  config: MailConfig,
  options: { budget?: MailBudget } = {},
  injected?: SesDependencies,
): MailTransport | undefined {
  if (!hasMail(config)) return undefined;
  const isSes = config.mailTransport === "ses";
  const isTwilioEmail = config.mailTransport === "twilio-email";
  if ((isSes || isTwilioEmail) && !options.budget)
    throw new Error("Mail provider requires a shared durable mail budget");
  const sesConfig = config.ses;
  const deps = isSes ? (injected ?? dependencies()) : undefined;
  if (deps) assertInstanceEnvironment(deps.environment());
  let closed = false;
  const pending = new Map<Promise<{ messageId?: string }>, AbortController>();
  return {
    sendMail(message) {
      if (closed) return Promise.reject(new Error("Mail transport is closed"));
      if (pending.size >= 32)
        return Promise.reject(new Error("Mail transport is busy"));
      let mail: SendMailOptions;
      try {
        mail = messageFor(config, message);
      } catch {
        return Promise.reject(new Error("Invalid mail message"));
      }
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), SEND_DEADLINE_MS);
      const signal = controller.signal;
      const task = (async () => {
        if (isTwilioEmail)
          return sendTwilioEmail(config, mail, options.budget!, signal);
        if (!isSes) {
          const result = await sendSmtp(config, mail, signal);
          return { messageId: result.messageId };
        }
        if (!deps || !sesConfig || !options.budget)
          throw new Error("Mail unavailable");
        const sender = nodemailer.createTransport({
          SES: {
            SendEmailCommand,
            sesClient: {
              config: { region: async () => sesConfig.region },
              async send(command: unknown) {
                signal.throwIfAborted();
                assertInstanceEnvironment(deps.environment());
                const credentials = snapshot(
                  await abortable(deps.credentials(), signal),
                );
                signal.throwIfAborted();
                assertInstanceEnvironment(deps.environment());
                const clients = deps.clients(credentials, sesConfig.region);
                try {
                  const identity = await clients.identity(
                    AbortSignal.any([
                      signal,
                      AbortSignal.timeout(SDK_DEADLINE_MS),
                    ]),
                  );
                  const roleName = sesConfig.roleArn.split("/").at(-1)!;
                  const expected = `arn:aws:sts::${sesConfig.accountId}:assumed-role/${roleName}/`;
                  if (
                    identity.Account !== sesConfig.accountId ||
                    !identity.Arn?.startsWith(expected) ||
                    !/^[A-Za-z0-9+=,.@_-]+$/.test(
                      identity.Arn.slice(expected.length),
                    )
                  )
                    throw new Error("Unexpected SES instance identity");
                  signal.throwIfAborted();
                  await options.budget!.reserve({
                    accountId: sesConfig.accountId,
                    region: sesConfig.region,
                    signal,
                  });
                  signal.throwIfAborted();
                  const input = (command as SendEmailCommand).input;
                  // Nodemailer may accept wider options in future; validate the final envelope too.
                  if (
                    input.Destination?.ToAddresses?.length !== 1 ||
                    input.Destination.CcAddresses?.length ||
                    input.Destination.BccAddresses?.length ||
                    mailbox(input.FromEmailAddress) !== mailbox(config.smtpFrom)
                  )
                    throw new Error("Invalid SES envelope");
                  input.ConfigurationSetName = sesConfig.configurationSet;
                  return await clients.send(
                    command as SendEmailCommand,
                    AbortSignal.any([
                      signal,
                      AbortSignal.timeout(SDK_DEADLINE_MS),
                    ]),
                  );
                } finally {
                  clients.close();
                }
              },
            },
          },
          logger: false,
          debug: false,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        try {
          const result = await sender.sendMail(mail);
          return { messageId: result.messageId };
        } finally {
          sender.close();
        }
      })()
        .catch(() => {
          // Provider errors can contain destinations, content or credentials.
          throw new Error("Mail delivery was not confirmed");
        })
        .finally(() => {
          clearTimeout(deadline);
          pending.delete(task);
        });
      pending.set(task, controller);
      return task;
    },
    async close() {
      closed = true;
      for (const controller of pending.values()) controller.abort();
      await Promise.allSettled(pending.keys());
    },
  };
}
