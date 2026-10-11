import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type RemoteParticipant } from "livekit-client";
import {
  api,
  ApiError,
  meetingPath,
  messageOf,
  participantMediaIdentity,
  type MeetingState,
  type Reaction,
  type ReactionKind,
} from "./api";
import { Icon } from "./icons";

export const REACTION_TOPIC = "covemeet.reaction.v1";
export const reactionLabels: Record<ReactionKind, string> = {
  like: "Like",
  applause: "Applause",
  love: "Love",
  laugh: "Laugh",
  surprised: "Surprised",
  celebrate: "Celebrate",
};
export type ReactionPacket = {
  version: 1;
  code: string;
  reaction: Reaction;
  serverTime: number;
};
export type ReactionUpdate = {
  reaction: Reaction;
  serverTime: number;
  revision: number;
};
export type VisibleReaction = Reaction & { name: string; deadline: number };
export type ReactionAnnouncement = { id: string; text: string };
export const reactionScope = (state: MeetingState) =>
  state.me.breakoutId ?? (state.me.webinarBackstage ? "@backstage" : "");
const sessionScope = (state: MeetingState) =>
  `${state.meeting.code}:${state.me.id}:${participantMediaIdentity(state.me)}:${reactionScope(state)}`;
export const reactionsAllowed = (state: MeetingState) =>
  !state.meeting.ended &&
  state.meeting.webinar?.phase !== "ended" &&
  state.me.status === "admitted" &&
  !state.me.enforcementPending &&
  state.me.mediaAllowed !== false &&
  state.me.transport !== "phone";

export function visibleReactionSender(state: MeetingState, reaction: Reaction) {
  if (!reactionsAllowed(state) || reaction.scope !== reactionScope(state))
    return;
  const sender = state.participants.find(
    (p) => p.id === reaction.participantId,
  );
  return sender &&
    sender.status === "admitted" &&
    sender.transport !== "phone" &&
    !sender.enforcementPending &&
    sender.mediaAllowed !== false &&
    sender.mediaVersion === reaction.mediaVersion &&
    participantMediaIdentity(sender) === reaction.mediaIdentity &&
    (sender.breakoutId ?? (sender.webinarBackstage ? "@backstage" : "")) ===
      reaction.scope &&
    !(
      state.meeting.mode === "webinar" &&
      state.me.role === "viewer" &&
      !state.me.moderator &&
      sender.role === "viewer" &&
      sender.id !== state.me.id
    )
    ? sender
    : undefined;
}

// SDK data from a participant is never a server-authorized reaction. Browser
// tokens cannot publish data; still validate source, topic and bounded payload.
export function decodeReactionPacket(
  payload: Uint8Array,
  participant: unknown,
  topic?: string,
): ReactionPacket | undefined {
  if (participant || topic !== REACTION_TOPIC || payload.byteLength > 2048)
    return;
  try {
    const packet = JSON.parse(new TextDecoder().decode(payload));
    const r = packet?.reaction;
    if (
      packet.version !== 1 ||
      typeof packet.code !== "string" ||
      packet.code.length > 80 ||
      !Number.isFinite(packet.serverTime) ||
      !r ||
      Object.keys(r).sort().join() !==
        "createdAt,expiresAt,id,kind,mediaIdentity,mediaVersion,participantId,scope" ||
      ![r.id, r.participantId, r.mediaIdentity].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
      ) ||
      typeof r.scope !== "string" ||
      r.scope.length > 80 ||
      !Object.hasOwn(reactionLabels, r.kind) ||
      !Number.isInteger(r.mediaVersion) ||
      r.mediaVersion < 0 ||
      !Number.isFinite(r.createdAt) ||
      r.expiresAt !== r.createdAt + 6000 ||
      r.createdAt > packet.serverTime ||
      r.expiresAt <= packet.serverTime
    )
      return;
    return packet;
  } catch {
    return;
  }
}

export class ReactionFeed {
  private scope = "";
  private latest = new Map<string, VisibleReaction>();
  private serverOffset: number | undefined;
  private lastServerTime = -Infinity;
  reset(state: MeetingState) {
    const scope = sessionScope(state);
    if (scope === this.scope) return;
    this.scope = scope;
    this.latest.clear();
    this.serverOffset = undefined;
    this.lastServerTime = -Infinity;
  }
  update(
    state: MeetingState,
    serverTime: number,
    reactions: Reaction[],
    now = Date.now(),
  ) {
    this.reset(state);
    // A delayed packet cannot move the server clock backwards or extend a TTL.
    if (Number.isFinite(serverTime) && serverTime > this.lastServerTime) {
      this.serverOffset = Math.min(
        this.serverOffset ?? Infinity,
        now - serverTime,
      );
      this.lastServerTime = serverTime;
    }
    const estimatedServerNow = now - (this.serverOffset ?? 0);
    const added: VisibleReaction[] = [];
    for (const reaction of reactions) {
      const sender = visibleReactionSender(state, reaction);
      const prior = this.latest.get(reaction.participantId);
      if (
        !sender ||
        reaction.expiresAt <= Math.max(serverTime, estimatedServerNow) ||
        (prior && reaction.createdAt <= prior.createdAt)
      )
        continue;
      const item = {
        ...reaction,
        name: sender.name,
        deadline:
          now +
          Math.min(
            6000,
            reaction.expiresAt - Math.max(serverTime, estimatedServerNow),
          ),
      };
      this.latest.set(reaction.participantId, item);
      added.push(item);
    }
    return added;
  }
  visible(state: MeetingState, now = Date.now()) {
    this.reset(state);
    for (const [id, reaction] of this.latest)
      if (!visibleReactionSender(state, reaction)) this.latest.delete(id);
    return [...this.latest.values()]
      .filter((r) => r.deadline > now)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, 6);
  }
}

export function useReactions(state: MeetingState, refresh: () => void) {
  const feed = useRef(new ReactionFeed());
  const current = useRef(state);
  current.current = state;
  const [tick, setTick] = useState(0);
  const [announcement, setAnnouncement] = useState<ReactionAnnouncement>({
    id: "",
    text: "",
  });
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const scope = sessionScope(state);
  const add = useCallback((serverTime: number, items: Reaction[]) => {
    const added = feed.current.update(current.current, serverTime, items);
    if (added.length)
      setAnnouncement({
        id: added.at(-1)!.id,
        text: added
          .slice(-6)
          .map((r) => `${r.name}: ${reactionLabels[r.kind]}`)
          .join(". "),
      });
    setTick((n) => n + 1);
  }, []);
  useEffect(() => {
    feed.current.reset(state);
    setAnnouncement({ id: "", text: "" });
    setError("");
  }, [scope]);
  useEffect(() => {
    if (state.reactions) add(state.reactions.serverTime, state.reactions.items);
  }, [state, add]);
  const receive = useCallback(
    (packet: ReactionPacket) => {
      if (packet.code === current.current.meeting.code)
        add(packet.serverTime, [packet.reaction]);
    },
    [add],
  );
  const items = feed.current.visible(state);
  const cooldown = cooldownUntil > Date.now();
  useEffect(() => {
    if (!items.length && !cooldown) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 200);
    return () => clearTimeout(timer);
  }, [tick, items.length, cooldown]);
  async function send(kind: ReactionKind) {
    if (
      sending.current ||
      cooldownUntil > Date.now() ||
      !reactionsAllowed(current.current)
    )
      return;
    const source = current.current;
    const sourceScope = sessionScope(source);
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const result = await api<ReactionUpdate>(
        meetingPath(source.meeting.code, "/reactions"),
        {
          kind,
          scope: reactionScope(source),
          mediaVersion: source.me.mediaVersion,
        },
      );
      if (sessionScope(current.current) === sourceScope) {
        add(result.serverTime, [result.reaction]);
        setCooldownUntil(
          Date.now() +
            Math.max(0, result.reaction.createdAt + 2000 - result.serverTime),
        );
      }
    } catch (e) {
      if (sessionScope(current.current) === sourceScope) {
        setError(messageOf(e));
        if (e instanceof ApiError && e.status === 409) refresh();
        if (e instanceof ApiError && e.status === 429)
          setCooldownUntil(Date.now() + 2000);
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return {
    items,
    announcement,
    receive,
    send,
    pending,
    cooldown,
    error,
    disabled: !reactionsAllowed(state),
  };
}

export function ReactionListener({
  receive,
}: {
  receive: (packet: ReactionPacket) => void;
}) {
  const room = useRoomContext();
  useEffect(() => {
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      const packet = decodeReactionPacket(payload, participant, topic);
      if (packet) receive(packet);
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, receive]);
  return null;
}

export function ReactionControl({
  disabled,
  pending,
  cooldown,
  error,
  send,
}: {
  disabled: boolean;
  pending: boolean;
  cooldown: boolean;
  error: string;
  send: (kind: ReactionKind) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (open) (pending || cooldown ? trigger.current : first.current)?.focus();
  }, [open, pending, cooldown]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div
      className="reaction-control"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="button"
        aria-label="Reactions"
        title="Reactions"
        aria-busy={pending}
        aria-expanded={open && !disabled}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="reaction" />
        <span>Reactions</span>
      </button>
      {open && !disabled && (
        <div
          id={id}
          className="reaction-picker"
          role="group"
          aria-label="Reactions"
        >
          {(Object.keys(reactionLabels) as ReactionKind[]).map(
            (kind, index) => (
              <button
                key={kind}
                ref={index === 0 ? first : undefined}
                type="button"
                aria-label={reactionLabels[kind]}
                disabled={pending || cooldown}
                onClick={() => {
                  close();
                  void send(kind);
                }}
              >
                {reactionLabels[kind]}
              </button>
            ),
          )}
          {(pending || cooldown) && (
            <span role="status">{pending ? "Sending…" : "Wait a moment"}</span>
          )}
        </div>
      )}
      {error && (
        <span className="reaction-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function ReactionStrip({
  items,
  announcement,
}: {
  items: VisibleReaction[];
  announcement: ReactionAnnouncement;
}) {
  return (
    <>
      <div className="reaction-strip" aria-hidden="true">
        {items.map((r) => (
          <span className="reaction-item" key={r.id}>
            <strong>{r.name}</strong> {reactionLabels[r.kind]}
          </span>
        ))}
      </div>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={announcement.id}>{announcement.text}</span>
      </span>
    </>
  );
}
