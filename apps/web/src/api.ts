export type Branding = {
  brandName: string;
  headline: string;
  description: string;
  accentColor: string;
  backgroundColor: string;
  font: "sans" | "serif" | "system";
  borderRadius: "square" | "rounded" | "pill";
  logoUrl?: string;
  backgroundUrl?: string;
  supportUrl?: string;
  supportLabel?: string;
  footerText?: string;
  showHostButton: boolean;
};

export type Config = {
  edition: "hosted" | "self-hosted";
  brandName: string;
  recordingAvailable: boolean;
  mediaAvailable: boolean;
  creationRequiresKey: boolean;
  branding?: Branding;
  portalOrigin?: string;
  meetingOrigin?: string;
};

export type Participant = {
  id: string;
  name: string;
  role: "host" | "participant" | "viewer";
  status: "waiting" | "admitted" | "kicked" | "banned" | "left";
  audioAllowed: boolean;
  videoAllowed: boolean;
  mediaVersion: number;
  breakoutId: string | null;
  enforcementPending?: boolean;
};

export type MeetingState = {
  meeting: {
    code: string;
    title: string;
    mode: "meeting" | "webinar";
    webinar?: {
      presenters: number;
      viewers: number;
      presenterLimit: number;
      viewerLimit: number;
    };
    locked: boolean;
    ended: boolean;
    recordingAllowed: boolean;
    recordingActive?: boolean;
    createdAt: string;
    hostEmailVerified?: boolean;
    breakouts?: { id: string; name: string }[];
  };
  me: Participant;
  participants: Participant[];
  messages: { id: string; name: string; text: string; createdAt: string }[];
  recordings: {
    id: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
    error?: string;
  }[];
  revision: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Requested-With": "MeetingPlatform",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data?.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request failed. Please try again.";
}

export function meetingPath(code: string, suffix = ""): string {
  return `/meetings/${encodeURIComponent(code)}${suffix}`;
}
