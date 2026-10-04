import path from "node:path";
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env) {
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32)
    throw new Error(
      "SESSION_SECRET must contain at least 32 random characters. Run npm run setup.",
    );
  const validateOrigin = (value: string) => {
    const u = new URL(value);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw new Error("Configure a bare HTTP(S) origin");
    if (env.NODE_ENV === "production" && u.protocol !== "https:")
      throw new Error("Production public origins require HTTPS");
    return u.origin;
  };
  const origin = validateOrigin(env.SITE_ORIGIN ?? "http://localhost:5173");
  const portalOrigin = validateOrigin(env.PORTAL_ORIGIN || origin);
  const edition = env.EDITION === "hosted" ? "hosted" : "self-hosted";
  if (edition === "hosted" && (env.CREATION_KEY?.length ?? 0) < 32)
    throw new Error("Hosted mode requires a random CREATION_KEY.");
  const recordingKeyProvider = env.RECORDING_KEY_PROVIDER ?? "local";
  if (!["local", "aws-kms"].includes(recordingKeyProvider))
    throw new Error("Unsupported recording key provider");
  const recordingStorage = env.RECORDING_STORAGE ?? "local";
  if (!["local", "s3"].includes(recordingStorage))
    throw new Error("Unsupported recording storage provider");
  const recordingLocalKeys: Record<string, string> = Object.create(null);
  if (env.RECORDING_LOCAL_KEYS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.RECORDING_LOCAL_KEYS);
    } catch {
      throw new Error(
        "RECORDING_LOCAL_KEYS must be a JSON object of key IDs and base64 keys",
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 64
    ) {
      throw new Error("RECORDING_LOCAL_KEYS must contain at most 64 keys");
    }
    for (const [id, value] of Object.entries(parsed)) {
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(id) ||
        typeof value !== "string" ||
        Buffer.from(value, "base64").length !== 32 ||
        Buffer.from(value, "base64").toString("base64") !== value
      ) {
        throw new Error(
          "Recording local key IDs or base64 key lengths are invalid",
        );
      }
      recordingLocalKeys[id] = value;
    }
  }
  const legacyKeyId = env.RECORDING_KEK_ID ?? "operator-kek-v1";
  if (env.RECORDING_KEK && !Object.hasOwn(recordingLocalKeys, legacyKeyId)) {
    // Keep the original deployment key ID so existing envelopes remain recoverable.
    recordingLocalKeys[legacyKeyId] = env.RECORDING_KEK;
  }
  const recordingMaxBytes = Number(env.RECORDING_MAX_BYTES ?? 64 * 1024 ** 3);
  if (
    !Number.isSafeInteger(recordingMaxBytes) ||
    recordingMaxBytes < 93 ||
    recordingMaxBytes > 64 * 1024 ** 3
  ) {
    throw new Error("RECORDING_MAX_BYTES must be between 93 bytes and 64 GiB");
  }
  return {
    secret,
    origin,
    portalOrigin,
    edition,
    brandName: env.BRAND_NAME ?? "Covemeet",
    databaseUrl:
      env.DATABASE_URL ?? "postgres://meeting:meeting@127.0.0.1:55432/meeting",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4100),
    creationKey: env.CREATION_KEY ?? "",
    livekitUrl: env.LIVEKIT_URL ?? "http://127.0.0.1:7880",
    livekitKey: env.LIVEKIT_API_KEY ?? "",
    livekitSecret: env.LIVEKIT_API_SECRET ?? env.LIVEKIT_SECRET ?? "",
    mediaUrl: env.LIVEKIT_PUBLIC_URL ?? "ws://localhost:4100",
    recordingEnabled: env.RECORDING_ENABLED === "true",
    recordingKek: env.RECORDING_KEK ?? "",
    recordingKeyProvider,
    recordingLocalKeys,
    recordingActiveKeyId: env.RECORDING_ACTIVE_KEY_ID ?? legacyKeyId,
    recordingKmsKeyArn: env.RECORDING_KMS_KEY_ARN ?? "",
    recordingKmsDecryptKeyArns: (env.RECORDING_KMS_DECRYPT_KEY_ARNS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    recordingKmsRegion:
      env.RECORDING_KMS_REGION ?? env.AWS_REGION ?? "us-east-1",
    recordingStorage,
    recordingS3Bucket: env.RECORDING_S3_BUCKET ?? "",
    recordingS3Region: env.RECORDING_S3_REGION ?? env.AWS_REGION ?? "us-east-1",
    recordingS3Endpoint: env.RECORDING_S3_ENDPOINT || undefined,
    recordingS3Prefix: env.RECORDING_S3_PREFIX ?? "recordings",
    recordingS3PathStyle: env.RECORDING_S3_PATH_STYLE === "true",
    recordingS3AllowLocalHttp:
      env.NODE_ENV !== "production" &&
      env.RECORDING_S3_ALLOW_LOCAL_HTTP === "true",
    recordingMaxBytes,
    recordingDir: path.resolve(env.RECORDING_DIR ?? "../../runtime/recordings"),
    egressFileRoot: env.EGRESS_FILE_ROOT ?? "/recordings",
    smtpHost: env.SMTP_HOST ?? "",
    smtpPort: Number(env.SMTP_PORT ?? 1025),
    smtpFrom: env.SMTP_FROM ?? "meetings@localhost",
    smtpSecure: env.SMTP_SECURE === "true",
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    trustProxy: env.TRUST_PROXY
      ? env.TRUST_PROXY.split(",").map((v) => v.trim())
      : (false as false | string[]),
    production: env.NODE_ENV === "production",
    staticDir: path.resolve(env.STATIC_DIR ?? "../web/dist"),
  };
}
