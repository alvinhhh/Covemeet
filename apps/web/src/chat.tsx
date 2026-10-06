import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MeetingState } from "./api";
import { Icon } from "./icons";
import { sendsChatOnEnter } from "./chat-state";

export function Chat({
  state,
  send,
  busy,
}: {
  state: MeetingState;
  send: (text: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [below, setBelow] = useState(false);
  const pending = useRef(false);
  const messages = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const last = state.messages.at(-1);
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
    if (busy || pending.current || !text.trim()) return;
    const draft = text;
    pending.current = true;
    setSending(true);
    try {
      if (await send(draft.trim())) {
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
            <p>Messages are visible to participants in this room.</p>
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
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      {below && (
        <button className="chat-latest" onClick={latest}>
          New messages <Icon name="arrow" size={14} />
        </button>
      )}
      <form className="chat-compose" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor="chat-text">
          Message this room
        </label>
        <textarea
          id="chat-text"
          placeholder="Message this room"
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
            disabled={busy || sending || !text.trim()}
          >
            {sending ? "Sending…" : "Send"}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
