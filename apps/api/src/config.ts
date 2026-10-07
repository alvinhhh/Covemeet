import path from "node:path";
import { readFileSync } from "node:fs";
import { loadMailConfig, mailbox } from "@meeting-platform/mail";
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env = process.env) {
  let databaseCa: string | undefined;
  if (env.DATABASE_CA_FILE) {
    try {
      databaseCa = readFileSync(env.DATABASE_CA_FILE, "utf8");
      if (!databaseCa.trim()) throw new Error();
    } catch {
      throw new Error("DATABASE_CA_FILE could not be read or is empty");
    }
  }
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
  const mail = loadMailConfig(env, {
    defaultFrom:
      edition === "hosted" ? "meetings@covemeet.io" : "meetings@localhost",
    defaultPort: 1025,
  });
  const sender = mailbox(mail.smtpFrom);
  if (
    edition === "hosted" &&
    (/@(?:[^@]+\.)?covemeet\.com$/i.test(sender) ||
      (mail.production && !/^[^@]+@covemeet\.io$/i.test(sender)))
  )
    throw new Error(
      "Hosted production email must send from covemeet.io; covemeet.com cannot send automated mail",
    );
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
  const phoneEnabled = env.PHONE_ENABLED === "true";
  const phoneGatewayKey = env.PHONE_GATEWAY_KEY ?? "";
  const phoneTrunkId = env.PHONE_TRUNK_ID ?? "";
  const phoneDialInNumber = env.PHONE_DIAL_IN_NUMBER ?? "";
  const phoneSipAddress = env.PHONE_SIP_ADDRESS ?? "";
  const boundedLimit = (
    key: string,
    fallback: number,
    maximum: number,
    minimum = 1,
  ) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`${key} must be between ${minimum} and ${maximum}`);
    return value;
  };
  const phoneMaxCalls = boundedLimit("PHONE_MAX_CALLS", 20, 20);
  const phoneLobbySeconds = boundedLimit("PHONE_LOBBY_SECONDS", 300, 300);
  const phoneMaxDurationSeconds = boundedLimit(
    "PHONE_MAX_DURATION_SECONDS",
    7200,
    7200,
  );
  if (phoneEnabled || phoneGatewayKey !== "") {
    if (
      phoneGatewayKey.length < 32 ||
      [
        secret,
        env.CREATION_KEY,
        env.LIVEKIT_API_SECRET,
        env.LIVEKIT_SECRET,
      ].includes(phoneGatewayKey)
    )
      throw new Error(
        "Phone gateway requires an independent random key of at least 32 characters",
      );
  }
  if (phoneEnabled) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(phoneTrunkId))
      throw new Error("PHONE_TRUNK_ID is required");
    if (!phoneDialInNumber && !phoneSipAddress)
      throw new Error("Configure a phone dial-in number or SIP address");
    if (phoneDialInNumber && !/^\+[1-9]\d{6,14}$/.test(phoneDialInNumber))
      throw new Error("PHONE_DIAL_IN_NUMBER must be E.164");
    if (phoneSipAddress && !/^sips?:[^\s<>]{1,200}$/.test(phoneSipAddress))
      throw new Error("PHONE_SIP_ADDRESS must be a SIP address");
  }
  if (
    !Number.isSafeInteger(recordingMaxBytes) ||
    recordingMaxBytes < 93 ||
    recordingMaxBytes > 64 * 1024 ** 3
  ) {
    throw new Error("RECORDING_MAX_BYTES must be between 93 bytes and 64 GiB");
  }
  const meetingParticipantLimit = boundedLimit(
    "MEETING_PARTICIPANT_LIMIT",
    100,
    1000,
  );
  const webinarParticipantLimit = boundedLimit(
    "WEBINAR_PARTICIPANT_LIMIT",
    1010,
    1010,
  );
  const meetingDurationSeconds = boundedLimit(
    "MEETING_DURATION_SECONDS",
    0,
    86400,
    0,
  );
  const freeMaxActiveRooms = boundedLimit("FREE_MAX_ACTIVE_ROOMS", 1, 1000);
  const meetingDataRetentionDays = boundedLimit(
    "MEETING_DATA_RETENTION_DAYS",
    0,
    36500,
    0,
  );
  const meetingDataRetentionMode =
    env.MEETING_DATA_RETENTION_MODE ?? "disabled";
  if (!["disabled", "preview", "delete"].includes(meetingDataRetentionMode))
    throw new Error(
      "MEETING_DATA_RETENTION_MODE must be disabled, preview or delete",
    );
  if (meetingDataRetentionMode !== "disabled" && !meetingDataRetentionDays)
    throw new Error(
      "Set MEETING_DATA_RETENTION_DAYS before enabling retention",
    );
  return {
    meetingParticipantLimit,
    webinarParticipantLimit,
    meetingDurationSeconds,
    hostAbsenceGraceSeconds:
      edition === "hosted"
        ? 300
        : boundedLimit("HOST_ABSENCE_GRACE_SECONDS", 300, 1800, 30),
    freeMaxActiveRooms,
    meetingDataRetentionDays,
    meetingDataRetentionMode,
    secret,
    origin,
    portalOrigin,
    edition,
    brandName: env.BRAND_NAME ?? "Covemeet",
    databaseUrl:
      env.DATABASE_URL ?? "postgres://meeting:meeting@127.0.0.1:55432/meeting",
    databaseCa,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4100),
    creationKey: env.CREATION_KEY ?? "",
    livekitUrl: env.LIVEKIT_URL ?? "http://127.0.0.1:7880",
    livekitKey: env.LIVEKIT_API_KEY ?? "",
    livekitSecret: env.LIVEKIT_API_SECRET ?? env.LIVEKIT_SECRET ?? "",
    phoneEnabled,
    // Only the isolated RTC stand-in tests may omit native dialog ownership.
    phoneAllowUnjournaledTestCalls: env.NODE_ENV === "test",
    phoneGatewayKey,
    phoneTrunkId,
    phoneDialInNumber,
    phoneSipAddress,
    phoneMaxCalls,
    phoneLobbySeconds,
    phoneMaxDurationSeconds,
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
    ...mail,
    trustProxy: env.TRUST_PROXY
      ? env.TRUST_PROXY.split(",").map((v) => v.trim())
      : (false as false | string[]),
    staticDir: path.resolve(env.STATIC_DIR ?? "../web/dist"),
  };
}
