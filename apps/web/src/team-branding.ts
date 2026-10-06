import type { Branding, Config } from "./api";
import {
  brandingProfileIdPattern,
  publicJson,
  scheduledMeetingStatus,
} from "./scheduled-status";

export function companySlug(path: string): string | undefined {
  const slug = path.match(/^\/t\/([^/]+)\/?$/)?.[1];
  return slug &&
    slug.length >= 3 &&
    slug.length <= 48 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    ? slug
    : undefined;
}

function presentation(
  profile: any,
  portalOrigin: string,
): Branding | undefined {
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !brandingProfileIdPattern.test(profile.id)
  )
    return;
  const b = profile.branding;
  if (!b || typeof b !== "object" || Array.isArray(b)) return;
  for (const [key, max] of Object.entries({
    brandName: 80,
    headline: 120,
    description: 500,
  }))
    if (
      typeof b[key] !== "string" ||
      b[key].length > max ||
      (key === "brandName" && !b[key].trim())
    )
      return;
  for (const key of ["accentColor", "backgroundColor"])
    if (typeof b[key] !== "string" || !/^#[a-f0-9]{6}$/i.test(b[key])) return;
  if (
    !["sans", "serif", "system"].includes(b.font) ||
    !["square", "rounded", "pill"].includes(b.borderRadius) ||
    typeof b.showHostButton !== "boolean"
  )
    return;
  for (const [key, slot] of [
    ["logoUrl", "logo"],
    ["backgroundUrl", "background"],
  ]) {
    if (b[key] !== undefined && b[key] !== "") {
      if (typeof b[key] !== "string") return;
      const prefix = `${portalOrigin}/api/public/team-assets/${profile.id}/${slot}/`;
      if (
        !b[key].startsWith(prefix) ||
        !/^[a-f0-9]{64}$/.test(b[key].slice(prefix.length))
      )
        return;
    }
  }
  for (const [key, max] of Object.entries({
    supportLabel: 50,
    footerText: 150,
  }))
    if (
      b[key] !== undefined &&
      (typeof b[key] !== "string" || b[key].length > max)
    )
      return;
  if (b.supportUrl !== undefined && b.supportUrl !== "") {
    if (typeof b.supportUrl !== "string" || b.supportUrl.length > 500) return;
    try {
      const url = new URL(b.supportUrl);
      if (url.protocol !== "https:" || url.username || url.password) return;
    } catch {
      return;
    }
  }
  return {
    brandName: b.brandName,
    headline: b.headline,
    description: b.description,
    accentColor: b.accentColor,
    backgroundColor: b.backgroundColor,
    font: b.font,
    borderRadius: b.borderRadius,
    showHostButton: b.showHostButton,
    logoUrl: b.logoUrl,
    backgroundUrl: b.backgroundUrl,
    supportUrl: b.supportUrl,
    supportLabel: b.supportLabel,
    footerText: b.footerText,
  };
}

// The route supplies a public hint only. A meeting always selects its own stored profile.
export async function routeBranding(
  config: Pick<Config, "edition" | "portalOrigin">,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Branding | undefined> {
  if (config.edition !== "hosted" || !config.portalOrigin) return;
  const company = companySlug(path);
  let endpoint: string, expectedId: string | undefined;
  if (company) endpoint = `/api/public/team-pages/${company}`;
  else {
    const room = path.match(/^\/(?:meet|join|host)\/([A-Za-z0-9-]{6,48})\/?$/);
    if (!room) return;
    const code = room[1].replaceAll("-", "").toUpperCase();
    const result = await publicJson(
      `/api/meetings/${code}/branding`,
      signal,
      fetcher,
    );
    const binding =
      result.status === 404
        ? await scheduledMeetingStatus(config, code, 404, signal, fetcher)
        : result.data;
    if (
      typeof binding?.brandingProfileId !== "string" ||
      !brandingProfileIdPattern.test(binding.brandingProfileId)
    )
      return;
    expectedId = binding.brandingProfileId;
    endpoint = `/api/public/team-branding/${expectedId}`;
  }
  if (signal.aborted) return;
  const result = await publicJson(
    `${config.portalOrigin}${endpoint}`,
    signal,
    fetcher,
  );
  if (
    signal.aborted ||
    (expectedId && result.data?.profile?.id !== expectedId) ||
    (company && result.data?.profile?.slug !== company)
  )
    return;
  return presentation(result.data?.profile, config.portalOrigin);
}
