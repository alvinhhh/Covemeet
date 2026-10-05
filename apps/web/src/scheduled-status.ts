import type { Config } from "./api";

// Only a missing room may ask the portal for a non-sensitive scheduled status.
// This never replaces core authentication or sends a meeting/session capability.
export async function scheduledMeetingPending(
  config: Pick<Config, "edition" | "portalOrigin">,
  code: string,
  status: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (
    status !== 404 ||
    config.edition !== "hosted" ||
    !config.portalOrigin ||
    !/^[A-F0-9]{34}$/.test(code)
  )
    return false;
  try {
    const response = await fetcher(
      `${config.portalOrigin}/api/schedules/status/${code}`,
      {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      },
    );
    return response.ok && (await response.json()).status === "not-started";
  } catch {
    return false;
  }
}
