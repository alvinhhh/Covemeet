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
