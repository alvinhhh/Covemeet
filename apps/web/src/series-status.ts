import type { Config } from "./api";
import { brandingProfileIdPattern, publicJson } from "./scheduled-status";

const codePattern = /^[A-F0-9]{34}$/;
export function seriesCode(path: string): string | undefined {
  const code = path.match(/^\/series\/([A-F0-9]{34})\/?$/)?.[1];
  return code && codePattern.test(code) ? code : undefined;
}
export type SeriesStatus =
  | { status: "ready"; code: string; brandingProfileId?: string }
  | { status: "not-started"; code?: string; brandingProfileId?: string }
  | { status: "retry" }
  | { status: "unavailable" };

export async function recurringMeetingStatus(
  config: Pick<Config, "edition" | "portalOrigin">,
  code: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SeriesStatus> {
  if (config.edition !== "hosted" || !config.portalOrigin || !codePattern.test(code) || signal.aborted)
    return { status: "unavailable" };
  const result = await publicJson(`${config.portalOrigin}/api/schedule-series/resolve/${code}`, signal, fetcher);
  if (!signal.aborted && (result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500))
    return { status: "retry" };
  const data = result.data;
  if (signal.aborted || result.status !== 200 || !data || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).some((key) => !["status", "code", "brandingProfileId"].includes(key)) ||
    !["ready", "not-started"].includes(data.status) ||
    (data.status === "ready" && typeof data.code !== "string") ||
    (data.code !== undefined && (typeof data.code !== "string" || !codePattern.test(data.code))) ||
    (data.brandingProfileId !== undefined && (typeof data.brandingProfileId !== "string" || !brandingProfileIdPattern.test(data.brandingProfileId))))
    return { status: "unavailable" };
  return { status: data.status, ...(data.code ? { code: data.code } : {}), ...(data.brandingProfileId ? { brandingProfileId: data.brandingProfileId } : {}) } as SeriesStatus;
}

export function seriesJoinPath(status: SeriesStatus): string | undefined {
  return status.status === "ready" && codePattern.test(status.code) ? `/join/${status.code}` : undefined;
}

export function seriesPollDelay(status: SeriesStatus, consecutiveFailures = 0, jitter = 0): number | undefined {
  const extra = Math.min(3000, Math.max(0, jitter));
  if (status.status === "not-started") return 15000 + extra;
  if (status.status === "retry") return Math.min(60000, 10000 * 2 ** Math.min(3, Math.max(1, consecutiveFailures)) + extra);
  return undefined;
}
