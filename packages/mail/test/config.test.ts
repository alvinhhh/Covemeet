import assert from "node:assert/strict";
import test from "node:test";
import { hasMail, loadMailConfig, mailbox } from "../src/config.js";

const defaults = { defaultFrom: "meetings@localhost", defaultPort: 1025 };
const ses = {
  MAIL_TRANSPORT: "ses",
  SES_REGION: "us-east-2",
  SES_ACCOUNT_ID: "123456789012",
  SES_ROLE_ARN: "arn:aws:iam::123456789012:role/mail/Sender",
  MAIL_DATABASE_URL: "postgres://mail:fixture@localhost/mail_test",
  AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
};

test("SMTP stays optional and local sender defaults remain valid", () => {
  const config = loadMailConfig({}, defaults);
  assert.equal(config.smtpFrom, "meetings@localhost");
  assert.equal(config.smtpPort, 1025);
  assert.equal(config.mailTransport, "smtp");
  assert.equal(hasMail(config), false);
  assert.equal(hasMail({ ...config, smtpHost: "localhost" }), true);
  assert.equal(
    mailbox("Covemeet <accounts@example.test>"),
    "accounts@example.test",
  );
  for (const SMTP_FROM of [
    "a@example.test,b@example.test",
    "a@example.test\r\nBcc: b@example.test",
    "a@example.test <b@example.test>",
  ])
    assert.throws(() => loadMailConfig({ SMTP_FROM }, defaults), /SMTP_FROM/);
});

test("SES needs explicit account, role, region, durable budget and fixed IMDS", () => {
  const config = loadMailConfig(ses, defaults);
  assert.equal(hasMail(config), true);
  assert.deepEqual(config.ses, {
    accountId: ses.SES_ACCOUNT_ID,
    roleArn: ses.SES_ROLE_ARN,
    region: "us-east-2",
    configurationSet: undefined,
  });
  for (const key of [
    "SES_REGION",
    "SES_ACCOUNT_ID",
    "SES_ROLE_ARN",
    "MAIL_DATABASE_URL",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  ])
    assert.throws(() => loadMailConfig({ ...ses, [key]: "" }, defaults));
  assert.throws(() =>
    loadMailConfig(
      { ...ses, SES_ROLE_ARN: "arn:aws:iam::999999999999:role/Sender" },
      defaults,
    ),
  );
  for (const [key, value] of Object.entries({
    AWS_ACCESS_KEY_ID: "fixture",
    AWS_PROFILE: "old-account",
    AWS_CONFIG_FILE: "/tmp/fixture",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://localhost",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/token",
    AWS_ENDPOINT_URL: "https://example.test",
    AWS_ENDPOINT_URL_SES_V2: "https://example.test",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://localhost",
    AWS_EC2_METADATA_DISABLED: "true",
  }))
    assert.throws(() => loadMailConfig({ ...ses, [key]: value }, defaults));
});

test("Twilio Email requires its own credentials and durable budget without AWS configuration", () => {
  const env = {
    MAIL_TRANSPORT: "twilio-email",
    TWILIO_EMAIL_ACCOUNT_SID: "AC" + "A".repeat(32),
    TWILIO_EMAIL_API_KEY_SID: "SK" + "b".repeat(32),
    TWILIO_EMAIL_API_KEY_SECRET: "c".repeat(32),
    MAIL_DATABASE_URL: "postgres://mail:fixture@localhost/mail_test",
  };
  const configured = loadMailConfig(env, defaults);
  assert.equal(configured.mailTransport, "twilio-email");
  assert.equal(configured.twilioEmail?.accountId, "AC" + "a".repeat(32));
  assert.equal(configured.ses, undefined);
  assert.equal(hasMail(configured), true);
  assert.equal(hasMail({ ...configured, mailDatabaseUrl: undefined }), false);
  for (const key of [
    "TWILIO_EMAIL_ACCOUNT_SID",
    "TWILIO_EMAIL_API_KEY_SID",
    "TWILIO_EMAIL_API_KEY_SECRET",
    "MAIL_DATABASE_URL",
  ])
    assert.throws(
      () => loadMailConfig({ ...env, [key]: "" }, defaults),
      /Twilio Email/,
    );
  for (const [key, value] of Object.entries({
    TWILIO_EMAIL_ACCOUNT_SID: "123456789012",
    TWILIO_EMAIL_API_KEY_SID: "AC" + "b".repeat(32),
    TWILIO_EMAIL_API_KEY_SECRET: "private\r\nheader",
  }))
    assert.throws(
      () => loadMailConfig({ ...env, [key]: value }, defaults),
      /Twilio Email/,
    );
  assert.equal(
    hasMail(
      loadMailConfig(
        { ...env, AWS_PROFILE: "unrelated", AWS_EC2_METADATA_DISABLED: "true" },
        defaults,
      ),
    ),
    true,
  );
});
