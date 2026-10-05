import assert from "node:assert/strict";
import test from "node:test";
import { hasMail } from "@meeting-platform/mail";
import { loadConfig } from "../src/config.js";

const base = { SESSION_SECRET: "test-mail-secret-with-at-least-32-characters" };
const hosted = {
  ...base,
  EDITION: "hosted",
  CREATION_KEY: "test-hosted-creation-key-with-at-least-32-characters",
};
const productionHosted = {
  ...hosted,
  NODE_ENV: "production",
  SITE_ORIGIN: "https://covemeet.io",
  PORTAL_ORIGIN: "https://covemeet.com",
};

test("self-hosted SMTP keeps local defaults and custom sender domains", () => {
  const empty = loadConfig(base);
  assert.equal(empty.smtpFrom, "meetings@localhost");
  assert.equal(empty.smtpPort, 1025);
  assert.equal(hasMail(empty), false);
  const local = loadConfig({
    ...base,
    SMTP_HOST: "mailpit",
    SMTP_FROM: "Example meetings <meetings@example.test>",
  });
  assert.equal(hasMail(local), true);
  assert.equal(local.smtpFrom, "Example meetings <meetings@example.test>");
  assert.equal(
    loadConfig({ ...base, SMTP_FROM: "meetings@covemeet.com" }).smtpFrom,
    "meetings@covemeet.com",
  );
});

test("hosted production mail requires covemeet.io while local capture stays available", () => {
  assert.equal(loadConfig(hosted).smtpFrom, "meetings@covemeet.io");
  assert.equal(
    loadConfig({
      ...productionHosted,
      SMTP_FROM: "Covemeet <meetings@covemeet.io>",
    }).smtpFrom,
    "Covemeet <meetings@covemeet.io>",
  );
  assert.equal(
    loadConfig({
      ...hosted,
      SMTP_HOST: "mailpit",
      SMTP_FROM: "meetings@covemeet.localhost",
    }).smtpFrom,
    "meetings@covemeet.localhost",
  );
  for (const sender of ["meetings@covemeet.com", "meetings@sub.covemeet.com"])
    assert.throws(() => loadConfig({ ...hosted, SMTP_FROM: sender }));
  for (const sender of [
    "meetings@covemeet.com",
    "meetings@sub.covemeet.com",
    "meetings@covemeet.localhost",
    "meetings@example.test",
    "meetings@sub.covemeet.io",
    "other@example.test, meetings@covemeet.io",
    "other@example.test <meetings@covemeet.io>",
    "meetings@covemeet.io\r\nBcc: other@example.test",
  ])
    assert.throws(() => loadConfig({ ...productionHosted, SMTP_FROM: sender }));
});

test("native SES mail is available without SMTP and requires complete configuration", () => {
  const ses = {
    ...hosted,
    MAIL_TRANSPORT: "ses",
    SES_REGION: "us-east-2",
    SES_ACCOUNT_ID: "123456789012",
    SES_ROLE_ARN: "arn:aws:iam::123456789012:role/MailTest",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
    MAIL_DATABASE_URL: "postgres://mail:unused@localhost/covemeet_mail_test",
  };
  const config = loadConfig(ses);
  assert.equal(config.mailTransport, "ses");
  assert.equal(config.smtpHost, "");
  assert.equal(hasMail(config), true);
  for (const field of [
    "SES_REGION",
    "SES_ACCOUNT_ID",
    "SES_ROLE_ARN",
    "MAIL_DATABASE_URL",
  ] as const) {
    assert.throws(() => loadConfig({ ...ses, [field]: "" }));
  }
  assert.throws(() => loadConfig({ ...base, MAIL_TRANSPORT: "unknown" }));
});
