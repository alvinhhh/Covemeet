import type { Config } from "./api";

export const brandingProfileIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Public presentation/status reads never carry account or meeting capabilities.
export async function publicJson(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; data?: any }> {
  try {
    const response = await fetcher(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok || !response.body) return { status: response.status };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) return { status: 0 };
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        data: JSON.parse(new TextDecoder().decode(bytes)),
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return { status: 0 };
  }
}

// Only a missing room may ask the fixed portal for a scheduled status.
export async function scheduledMeetingStatus(
  config: Pick<Config, "edition" | "portalOrigin">,
  code: string,
  status: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ status: "not-started"; brandingProfileId?: string } | null> {
  if (
    status !== 404 ||
    config.edition !== "hosted" ||
    !config.portalOrigin ||
    !/^[A-F0-9]{34}$/.test(code)
  )
    return null;
  const result = await publicJson(
    `${config.portalOrigin}/api/schedules/status/${code}`,
    signal,
    fetcher,
  );
  if (result.data?.status !== "not-started") return null;
  return {
    status: "not-started",
    ...(typeof result.data.brandingProfileId === "string" &&
    brandingProfileIdPattern.test(result.data.brandingProfileId)
      ? { brandingProfileId: result.data.brandingProfileId }
      : {}),
  };
}

export async function scheduledMeetingPending(
  config: Pick<Config, "edition" | "portalOrigin">,
  code: string,
  status: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  return (
    (await scheduledMeetingStatus(config, code, status, signal, fetcher)) !==
    null
  );
}
