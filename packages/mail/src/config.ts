export interface MailConfig {
  production: boolean;
  mailTransport?: "smtp" | "ses" | "twilio-email";
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpFrom: string;
  smtpUser?: string;
  smtpPass?: string;
  mailDatabaseUrl?: string;
  mailDatabaseCaFile?: string;
  ses?: {
    region: string;
    accountId: string;
    roleArn: string;
    configurationSet?: string;
  };
  twilioEmail?: {
    accountId: string;
    apiKeySid: string;
    apiKeySecret: string;
  };
}

export const IMDS_ENDPOINT = "http://169.254.169.254";

// The SDK IMDS provider otherwise permits an endpoint from shared AWS profiles.
// Pinning the environment endpoint takes precedence without changing global state.
export function assertInstanceEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== IMDS_ENDPOINT)
    throw new Error("SES requires the fixed EC2 instance metadata endpoint");
  const forbidden = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  ];
  if (
    forbidden.some((name) => Boolean(env[name])) ||
    Object.keys(env).some(
      (name) => name.startsWith("AWS_ENDPOINT_URL") && Boolean(env[name]),
    ) ||
    env.AWS_EC2_METADATA_DISABLED === "true"
  )
    throw new Error(
      "SES requires instance credentials without AWS credential or endpoint overrides",
    );
}

export function mailbox(value: unknown): string {
  if (typeof value !== "string" || /[\r\n]/.test(value))
    throw new Error("Mail requires one valid email address");
  const address = value.match(/^[^<>@,;\r\n]*<([^<>\s,;]+)>$/)?.[1] ?? value;
  if (!/^[^@\s<>(),;:"\\]+@[^@\s<>(),;:"\\]+$/.test(address))
    throw new Error("Mail requires one valid email address");
  return address;
}

export function loadMailConfig(
  env: NodeJS.ProcessEnv,
  defaults: { defaultFrom: string; defaultPort: number },
): MailConfig {
  const mode = env.MAIL_TRANSPORT ?? "smtp";
  if (mode !== "smtp" && mode !== "ses" && mode !== "twilio-email")
    throw new Error("Invalid MAIL_TRANSPORT");
  const smtpPort = Number(env.SMTP_PORT ?? defaults.defaultPort);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
    throw new Error("Invalid SMTP_PORT");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS))
    throw new Error("SMTP_USER and SMTP_PASS must be configured together");
  const smtpFrom = env.SMTP_FROM ?? defaults.defaultFrom;
  try {
    mailbox(smtpFrom);
  } catch {
    throw new Error("SMTP_FROM must be one valid email address");
  }
  const config: MailConfig = {
    production: env.NODE_ENV === "production",
    mailTransport: mode,
    smtpHost: env.SMTP_HOST ?? "",
    smtpPort,
    smtpSecure: env.SMTP_SECURE === "true",
    smtpFrom,
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    mailDatabaseUrl: env.MAIL_DATABASE_URL,
    mailDatabaseCaFile: env.MAIL_DATABASE_CA_FILE,
  };
  if (mode === "ses") {
    assertInstanceEnvironment(env);
    const {
      SES_REGION: region = "",
      SES_ACCOUNT_ID: accountId = "",
      SES_ROLE_ARN: roleArn = "",
    } = env;
    if (
      !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
      !/^\d{12}$/.test(accountId) ||
      !new RegExp(
        `^arn:aws:iam::${accountId}:role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]+$`,
      ).test(roleArn)
    )
      throw new Error(
        "SES requires an explicit region, account and matching IAM role ARN",
      );
    if (!config.mailDatabaseUrl)
      throw new Error("SES requires MAIL_DATABASE_URL");
    const configurationSet = env.SES_CONFIGURATION_SET || undefined;
    if (configurationSet && !/^[A-Za-z0-9_-]{1,64}$/.test(configurationSet))
      throw new Error("Invalid SES_CONFIGURATION_SET");
    config.ses = { region, accountId, roleArn, configurationSet };
  }
  if (mode === "twilio-email") {
    const {
      TWILIO_EMAIL_ACCOUNT_SID: accountId = "",
      TWILIO_EMAIL_API_KEY_SID: apiKeySid = "",
      TWILIO_EMAIL_API_KEY_SECRET: apiKeySecret = "",
    } = env;
    if (
      !/^AC[0-9a-fA-F]{32}$/.test(accountId) ||
      !/^SK[0-9a-fA-F]{32}$/.test(apiKeySid) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(apiKeySecret)
    )
      throw new Error(
        "Twilio Email requires an account SID and API key credentials",
      );
    if (!config.mailDatabaseUrl)
      throw new Error("Twilio Email requires MAIL_DATABASE_URL");
    config.twilioEmail = {
      accountId: `AC${accountId.slice(2).toLowerCase()}`,
      apiKeySid,
      apiKeySecret,
    };
  }
  return config;
}

export function hasMail(config: MailConfig): boolean {
  if (config.mailTransport === "twilio-email")
    return Boolean(config.twilioEmail && config.mailDatabaseUrl);
  return config.mailTransport === "ses"
    ? Boolean(config.ses && config.mailDatabaseUrl)
    : Boolean(config.smtpHost);
}
