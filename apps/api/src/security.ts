import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const keyedDigest = (secret: string, value: string) =>
  createHmac("sha256", secret).update(value).digest("hex");
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function meetingCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)].map((n) => alphabet[n & 31]).join("");
}
export const normalizeCode = (s: string) => s.replace(/-/g, "").toUpperCase();
let passwordJobs = 0;
export async function passwordWork<T>(work: () => Promise<T>): Promise<T> {
  if (passwordJobs >= 6)
    throw new HttpError(
      429,
      "Password verification is busy. Try again shortly.",
    );
  passwordJobs++;
  try {
    return await work();
  } finally {
    passwordJobs--;
  }
}
export function passwordHash(p: string) {
  return passwordWork(() =>
    argon2.hash(p, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  );
}
export function checkPassword(hash: string, p: string) {
  return passwordWork(async () => {
    try {
      return await argon2.verify(hash, p);
    } catch {
      return false;
    }
  });
}
export function signedDevice(secret: string, id = randomToken()) {
  return `${id}.${keyedDigest(secret, `device:${id}`)}`;
}
export function verifyDevice(secret: string, value?: string) {
  if (!value) return null;
  const [id, sig] = value.split(".");
  return id && sig && safeEqual(sig, keyedDigest(secret, `device:${id}`))
    ? id
    : null;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

// Valid sessions behind one gateway have independent budgets. Invalid sessions
// still consume the existing shared IP budget, checked before another lookup.
export function authenticatedRateLimit(
  app: FastifyInstance,
  identify: (req: FastifyRequest) => Promise<string | undefined>,
  max = 120,
) {
  const ipBudget = app.createRateLimit();
  const keys = new WeakMap<FastifyRequest, string>();
  const sessionBudget = app.createRateLimit({
    max,
    timeWindow: "1 minute",
    keyGenerator: (req) => keys.get(req)!,
  });
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = await ipBudget(req, { increment: false });
    if (!ip.isAllowed && ip.remaining === 0) {
      reply.header("retry-after", ip.ttlInSeconds);
      throw new HttpError(429, "Too many attempts. Try again shortly.");
    }
    const key = await identify(req);
    if (key) keys.set(req, key);
    const result = await (key ? sessionBudget(req) : ipBudget(req));
    if (!result.isAllowed && result.isExceeded) {
      reply.header("retry-after", result.ttlInSeconds);
      throw new HttpError(429, "Too many attempts. Try again shortly.");
    }
  };
}
