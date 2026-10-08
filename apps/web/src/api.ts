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
  phoneAvailable: boolean;
  creationRequiresKey: boolean;
  branding?: Branding;
  portalOrigin?: string;
  meetingOrigin?: string;
};

export type Participant = {
  id: string;
  name: string;
  role: "host" | "participant" | "viewer";
  moderator?: boolean;
  moderatorRevision?: number;
  status: "waiting" | "admitted" | "kicked" | "banned" | "left";
  audioAllowed: boolean;
  videoAllowed: boolean;
  screenShareAllowed: boolean;
  mediaVersion: number;
  mediaIdentity?: string;
  breakoutId: string | null;
  webinarLocation?: "backstage" | "stage";
  webinarBackstage?: boolean;
  mediaAllowed?: boolean;
  enforcementPending?: boolean;
  handRaised?: boolean;
  transport: "browser" | "phone";
  phone?: {
    muted: boolean;
    handRaised: boolean;
    canBanCallerId: boolean;
  };
};

export function participantMediaIdentity(
  participant: Pick<Participant, "id" | "mediaIdentity">,
): string {
  return participant.mediaIdentity ?? participant.id;
}

export type PhoneAccess = {
  enabled: boolean;
  locator?: string;
  dialInNumber?: string;
  sipAddress?: string;
};

export type ChatMode = "everyone" | "host-only" | "disabled";

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
      phase: "backstage" | "live" | "ended";
      revision: number;
      canManage: boolean;
    };
    locked: boolean;
    ended: boolean;
    cleanupPending?: boolean;
    controllerId?: string;
    controlRevision?: number;
    hostAbsentSince?: number;
    canEnd?: boolean;
    participantLimit?: number;
    attendeeCount: number;
    startedAt?: number;
    deadlineAt?: number;
    usage?: null | {
      window: { start: number; end: number };
      participantSeconds: {
        limit: number | null;
        used: number;
        reserved: number;
        available: number | null;
      };
      recordingSeconds?: {
        limit: number;
        used: number;
        reserved: number;
        available: number;
      };
      blocked: boolean;
    };
    recordingAllowed: boolean;
    chatMode?: ChatMode;
    recordingAvailable?: boolean;
    recordingActive?: boolean;
    createdAt: string;
    hostEmailVerified?: boolean;
    breakouts?: { id: string; name: string }[];
  };
  me: Participant;
  participants: Participant[];
  messages: {
    id: string;
    sequence?: number;
    senderId?: string;
    recipientId?: string;
    deleted?: boolean;
    name: string;
    text: string;
    createdAt: string;
  }[];
  recordings: {
    id: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
    error?: string;
  }[];
  revision: number;
};

export type RecordingArchive = {
  title: string;
  recordings: {
    id: string;
    status: string;
    createdAt: number;
    expiresAt?: number;
    error?: string;
  }[];
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
