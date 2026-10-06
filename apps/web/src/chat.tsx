import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import type { ChatMode, MeetingState } from "./api";
import { Icon } from "./icons";
import { sendsChatOnEnter } from "./chat-state";

export function Chat({
  state,
  text,
  setText,
  send,
  busy,
  recipient,
  setRecipient,
  setMode,
  remove,
}: {
  state: MeetingState;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  send: (text: string, recipient: string) => Promise<boolean>;
  busy: boolean;
  recipient: string;
  setRecipient: (recipient: string) => void;
  setMode: (mode: ChatMode) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}) {
  const [sending, setSending] = useState(false);
  const [below, setBelow] = useState(false);
  const pending = useRef(false);
  const messages = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const last = state.messages.at(-1);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const host = state.me.role === "host";
  const backstage =
    state.meeting.mode === "webinar" && state.me.webinarBackstage === true;
  const mode = state.meeting.chatMode ?? "everyone";
  const target = state.participants.find((entry) => entry.id === recipient);
  const unavailable =
    recipient !== "everyone" &&
    recipient !== "host" &&
    (!host ||
      !target ||
      target.status !== "admitted" ||
      target.transport === "phone");
  const restriction =
    mode === "disabled"
      ? "Chat is off"
      : mode === "host-only" && !host
        ? "Only the host can send messages"
        : unavailable
          ? "Recipient unavailable"
          : "";
  const messageLabel =
    recipient === "everyone"
      ? backstage
        ? "Message backstage"
        : "Message this room"
      : recipient === "host"
        ? "Message host"
        : `Message ${target?.name ?? "participant"}`;
  function reply(id: string) {
    setRecipient(id);
    textarea.current?.focus();
  }
  function latest() {
    const element = messages.current;
    if (element) element.scrollTop = element.scrollHeight;
    following.current = true;
    setBelow(false);
  }
  useEffect(() => {
    if (following.current) latest();
    else setBelow(true);
  }, [last?.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || pending.current || restriction || !text.trim()) return;
    const draft = text;
    pending.current = true;
    setSending(true);
    try {
      if (await send(draft.trim(), recipient)) {
        // Preserve anything typed while the request was pending.
        setText((current) => (current === draft ? "" : current));
        latest();
      }
    } finally {
      pending.current = false;
      setSending(false);
    }
  }
  return (
    <div className="chat-panel">
      {host && (
        <div className="chat-policy">
          <span id="chat-policy-label">Who can send?</span>
          <div
            className="chat-options"
            role="group"
            aria-labelledby="chat-policy-label"
          >
            {(
              [
                ["everyone", "Everyone"],
                ["host-only", "Host only"],
                ["disabled", "No one"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                disabled={busy}
                onClick={() => void setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className="chat-messages"
        ref={messages}
        role="log"
        aria-label="Meeting messages"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
          if (following.current) setBelow(false);
        }}
      >
        {state.messages.length === 0 && (
          <div className="empty-panel">
            <Icon name="chat" size={30} />
            <h3>No messages</h3>
          </div>
        )}
        {state.messages.map((message) => (
          <article
            className={`chat-message${message.senderId === state.me.id ? " own-message" : ""}`}
            key={message.id}
          >
            <header>
              <strong>{message.name}</strong>
              <time dateTime={new Date(message.createdAt).toISOString()}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </header>
            {message.recipientId && (
              <small className="chat-private">
                {message.recipientId === state.me.id
                  ? "Private to you"
                  : state.participants.find(
                        (entry) => entry.id === message.recipientId,
                      )?.role === "host"
                    ? "Private to host"
                    : state.participants.some(
                          (entry) => entry.id === message.recipientId,
                        )
                      ? `Private to ${state.participants.find((entry) => entry.id === message.recipientId)!.name}`
                      : "Private message"}
              </small>
            )}
            <p className={message.deleted ? "chat-removed" : undefined}>
              {message.deleted ? "Message removed" : message.text}
            </p>
            {host && (
              <div className="chat-message-actions">
                {!message.deleted &&
                  message.senderId !== state.me.id &&
                  state.participants.some(
                    (entry) =>
                      entry.id === message.senderId &&
                      entry.status === "admitted" &&
                      entry.transport !== "phone",
                  ) && (
                    <button
                      type="button"
                      disabled={busy || mode === "disabled"}
                      onClick={() => reply(message.senderId!)}
                    >
                      Reply privately
                    </button>
                  )}
                {!message.deleted && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(message.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {below && (
        <button className="chat-latest" onClick={latest}>
          New messages <Icon name="arrow" size={14} />
        </button>
      )}
      <form className="chat-compose" onSubmit={(event) => void submit(event)}>
        <div
          className="chat-options chat-recipients"
          role="group"
          aria-label="Message recipient"
        >
          <button
            type="button"
            aria-pressed={recipient === "everyone"}
            disabled={busy}
            onClick={() => setRecipient("everyone")}
          >
            {backstage ? "Backstage" : "Everyone"}
          </button>
          {!host && (
            <button
              type="button"
              aria-pressed={recipient === "host"}
              disabled={busy}
              onClick={() => setRecipient("host")}
            >
              {state.participants.some(
                (p) => p.role === "host" && p.status === "admitted",
              )
                ? "Host"
                : "Host (away)"}
            </button>
          )}
          {host && recipient !== "everyone" && (
            <span className="chat-recipient">
              {target?.name ?? "Participant unavailable"} · Private
            </span>
          )}
        </div>
        {restriction && (
          <p className="chat-restriction" role="status">
            {restriction}
          </p>
        )}
        <label className="sr-only" htmlFor="chat-text">
          {messageLabel}
        </label>
        <textarea
          id="chat-text"
          placeholder={messageLabel}
          ref={textarea}
          disabled={Boolean(restriction)}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (sendsChatOnEnter(event.nativeEvent)) {
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={2000}
          rows={3}
          autoFocus
          aria-describedby="chat-keyboard-hint"
        />
        <div className="chat-compose-actions">
          <small id="chat-keyboard-hint">Shift + Enter for a new line</small>
          <button
            className="button primary small"
            type="submit"
            disabled={busy || sending || Boolean(restriction) || !text.trim()}
          >
            {sending ? "Sending…" : "Send"}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
