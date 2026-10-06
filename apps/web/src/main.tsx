import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  VideoTrack,
  isTrackReference,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import {
  api,
  ApiError,
  meetingPath,
  messageOf,
  participantMediaIdentity,
  type Config,
  type MeetingState,
  type Participant,
  type Branding,
  type PhoneAccess,
} from "./api";
import { Icon } from "./icons";
import "./styles.css";
import { brandLogo } from "./brand";
import { scheduledMeetingPending } from "./scheduled-status";
import { BrandingEditor } from "./branding";
import { selectStage } from "./stage-policy";
import {
  observeAudioSignals,
  offscreenSpeakers,
  type AudioSignal,
} from "./audio-signal";
import { DeviceCheck } from "./device-check";
import { Chat } from "./chat";
import { ChatUnread } from "./chat-state";
import { Whiteboard } from "./whiteboard";
import { type Viewport } from "./whiteboard-state";
import { SpeakingBadge } from "./speaking-badge";

// A host capability is exchanged once, held only in memory, and removed before rendering.
let initialHostToken = location.pathname.startsWith("/host/")
  ? location.hash.slice(1)
  : "";
let initialDownloadToken = location.pathname.startsWith("/download/")
  ? location.hash.slice(1)
  : "";
if (initialHostToken || initialDownloadToken)
  history.replaceState(null, "", location.pathname + location.search);

const roomOptions = { adaptiveStream: true, dynacast: true };
const connectionOptions = { autoSubscribe: false };
const BrandingContext = createContext<Branding | undefined>(undefined);
let controlPanelOrigin = location.origin;

function homeHref() {
  return new URL(
    controlPanelOrigin === location.origin ? "/" : "/meetings",
    controlPanelOrigin,
  ).href;
}
function navigate(path: string) {
  if (path === "/" && controlPanelOrigin !== location.origin) {
    location.assign(homeHref());
    return;
  }
  const target = new URL(path, location.origin);
  if (target.origin !== location.origin) {
    location.assign(target.href);
    return;
  }
  history.pushState(null, "", target.pathname + target.search + target.hash);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function homeLabel() {
  return controlPanelOrigin === location.origin ? "Control panel" : "Meetings";
}
function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase())
      .join("") || "?"
  );
}
function Button({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button ${className}`} {...props}>
      {children}
    </button>
  );
}
function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "info" | "success";
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Logo({ name, small = false }: { name: string; small?: boolean }) {
  const branding = useContext(BrandingContext);
  const logo = brandLogo(branding?.brandName || name, branding?.logoUrl);
  return (
    <a
      href={homeHref()}
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
      className={`brand ${small ? "small" : ""}`}
    >
      {logo ? (
        <img
          className={`brand-image ${!branding?.logoUrl ? "covemeet-mark" : ""}`}
          src={logo}
          alt=""
        />
      ) : (
        <span className="brand-icon">
          <Icon name="video" size={21} />
        </span>
      )}
      <span>{branding?.brandName || name}</span>
    </a>
  );
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  useEffect(() => {
    if (!config) return;
    const logo = brandLogo(
      config.branding?.brandName || config.brandName,
      config.branding?.logoUrl,
    );
    const existing = document.querySelector<HTMLLinkElement>("#brand-favicon");
    if (!logo) {
      existing?.remove();
      return;
    }
    const icon = existing || document.createElement("link");
    icon.id = "brand-favicon";
    icon.rel = "icon";
    icon.href = logo;
    if (!existing) document.head.append(icon);
  }, [config]);
  useEffect(() => {
    if (!config?.branding) return;
    const b = config.branding;
    const style = document.documentElement.style;
    style.setProperty("--accent", b.accentColor);
    style.setProperty("--page-background", b.backgroundColor);
    style.setProperty(
      "--radius",
      b.borderRadius === "square"
        ? "2px"
        : b.borderRadius === "pill"
          ? "24px"
          : "14px",
    );
    style.setProperty(
      "--button-radius",
      b.borderRadius === "square"
        ? "2px"
        : b.borderRadius === "pill"
          ? "24px"
          : "8px",
    );
    style.setProperty(
      "--font",
      b.font === "serif"
        ? "Georgia, serif"
        : b.font === "system"
          ? "system-ui, sans-serif"
          : "Inter, system-ui, sans-serif",
    );
    document.title = b.brandName;
  }, [config]);
  useEffect(() => {
    const changed = () => setPath(location.pathname);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    api<Config>("/config")
      .then((value) => {
        controlPanelOrigin = value.portalOrigin || location.origin;
        setConfig(value);
        document.title = value.brandName;
      })
      .catch((e) => setError(messageOf(e)));
  }, [configAttempt]);
  if (error)
    return (
      <Center>
        <Icon name="video" size={40} />
        <h1>Service unavailable</h1>
        <Notice>{error}</Notice>
        <Button
          onClick={() => {
            setError("");
            setConfigAttempt((attempt) => attempt + 1);
          }}
        >
          Try again
        </Button>
      </Center>
    );
  if (!config)
    return (
      <Center>
        <div className="spinner" />
        <p>Loading control panel…</p>
      </Center>
    );
  const room = path.match(/^\/(meet|join|host)\/([^/]+)\/?$/);
  const download = path.match(/^\/download\/([^/]+)\/?$/);
  let view: ReactNode;
  if (download)
    view = <Download code={decodeURIComponent(download[1])} config={config} />;
  else if (room)
    view = (
      <Meeting
        key={room[2]}
        code={decodeURIComponent(room[2])}
        hostEntry={room[1] === "host"}
        config={config}
      />
    );
  else if (path === "/branding" && config.edition === "self-hosted")
    view = (
      <BrandingEditor
        config={config}
        onSaved={setConfig}
        onBack={() => navigate("/")}
      />
    );
  else if (path !== "/")
    view = (
      <Center>
        <h1>Page not found</h1>
        <Button onClick={() => navigate("/")}>{homeLabel()}</Button>
      </Center>
    );
  else view = <Home config={config} />;
  return (
    <BrandingContext.Provider value={config.branding}>
      {view}
    </BrandingContext.Provider>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <main className="center-page">
      <div className="center-card">{children}</div>
    </main>
  );
}

function Home({ config }: { config: Config }) {
  const showCreationForm =
    config.edition === "self-hosted" &&
    config.branding?.showHostButton !== false;
  const [mode, setMode] = useState<"meeting" | "webinar">("meeting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joinCode, setJoinCode] = useState("");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ code: string; hostToken: string }>(
        "/meetings",
        {
          title: data.get("title"),
          hostName: data.get("hostName"),
          password: data.get("password"),
          mode,
          ...(config.edition === "self-hosted" && data.get("customCode")
            ? { customCode: data.get("customCode") }
            : {}),
          ...(config.creationRequiresKey
            ? { creationKey: data.get("creationKey") }
            : {}),
        },
      );
      if (
        config.meetingOrigin &&
        new URL(config.meetingOrigin).origin !== location.origin
      ) {
        location.assign(
          new URL(
            `/host/${encodeURIComponent(result.code)}#${encodeURIComponent(result.hostToken)}`,
            config.meetingOrigin,
          ).href,
        );
        return;
      }
      // Exchange directly after creation: no bearer secret is put into history or storage.
      await api(meetingPath(result.code, "/host"), { token: result.hostToken });
      navigate(`/meet/${encodeURIComponent(result.code)}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  function join(event: FormEvent) {
    event.preventDefault();
    let code = joinCode.trim();
    const meetingOrigin = config.meetingOrigin || location.origin;
    try {
      const url = new URL(code);
      if (url.origin !== new URL(meetingOrigin).origin) throw new Error();
      code = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    } catch {
      /* A direct code is expected unless this is an installation meeting link. */
    }
    if (/^[A-Za-z0-9_-]{3,100}$/.test(code))
      navigate(
        new URL(`/join/${encodeURIComponent(code)}`, meetingOrigin).href,
      );
    else
      setError(
        "Enter a valid meeting code or a meeting link from this installation.",
      );
  }
  return (
    <div
      className="dashboard"
      style={
        config.branding?.backgroundUrl
          ? {
              backgroundImage: `linear-gradient(var(--page-background), transparent), url(${JSON.stringify(config.branding.backgroundUrl)})`,
              backgroundSize: "cover",
              backgroundAttachment: "fixed",
            }
          : undefined
      }
    >
      <aside className="sidebar">
        <Logo name={config.brandName} />
        <div className="nav-label">WORKSPACE</div>
        <div className="nav-item active">
          <Icon name="grid" />
          Control panel
        </div>
        {config.edition === "self-hosted" && (
          <button
            className="nav-item nav-button"
            onClick={() => navigate("/branding")}
          >
            <Icon name="settings" />
            Branding
          </button>
        )}
        <div className="sidebar-bottom">
          <span className="edition-dot" />
          {config.edition === "self-hosted"
            ? "Self-hosted installation"
            : "Hosted installation"}
        </div>
      </aside>
      <div className="dashboard-body">
        <header className="dashboard-header">
          <span className="dashboard-location">Control panel</span>
          <div className="mobile-brand">
            <Logo name={config.brandName} />
          </div>
          <span className="header-tag">Browser meetings</span>
        </header>
        <main className="dashboard-main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">MEETINGS</p>
              <h1>{config.branding?.headline || "Start or join a meeting"}</h1>
              {config.branding?.description && (
                <p className="landing-description">
                  {config.branding.description}
                </p>
              )}
            </div>
            <div className="heading-icon">
              <Icon name="video" size={26} />
            </div>
          </div>
          {!config.mediaAvailable && (
            <Notice kind="info">
              Audio and video are not configured on this installation. Room
              access, chat, and host controls are available.
            </Notice>
          )}
          {error && <Notice>{error}</Notice>}
          <div className={`home-grid ${!showCreationForm ? "join-only" : ""}`}>
            {showCreationForm && (
              <section className="card create-card">
                <div className="card-title">
                  <div className="feature-icon">
                    <Icon name="plus" />
                  </div>
                  <div>
                    <h2>Create a room</h2>
                    <p>Set access and meeting type.</p>
                  </div>
                </div>
                <form onSubmit={create} className="form-stack">
                  <div className="mode-picker" aria-label="Meeting type">
                    <button
                      type="button"
                      aria-pressed={mode === "meeting"}
                      className={mode === "meeting" ? "selected" : ""}
                      onClick={() => setMode("meeting")}
                    >
                      <Icon name="users" />
                      <span>
                        Meeting<small>Everyone can participate</small>
                      </span>
                      {mode === "meeting" && <Icon name="check" size={16} />}
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "webinar"}
                      className={mode === "webinar" ? "selected" : ""}
                      onClick={() => setMode("webinar")}
                    >
                      <Icon name="screen" />
                      <span>
                        Webinar<small>Host-controlled stage</small>
                      </span>
                      {mode === "webinar" && <Icon name="check" size={16} />}
                    </button>
                  </div>
                  <Field label="Meeting title">
                    <input
                      name="title"
                      placeholder="e.g. Product review"
                      required
                      maxLength={120}
                    />
                  </Field>
                  <div className="form-row">
                    <Field label="Host name">
                      <input
                        name="hostName"
                        placeholder="Display name"
                        required
                        maxLength={80}
                        autoComplete="name"
                      />
                    </Field>
                    <Field label="Meeting password">
                      <input
                        name="password"
                        type="password"
                        required
                        maxLength={128}
                        autoComplete="new-password"
                      />
                    </Field>
                  </div>
                  {config.edition === "self-hosted" && (
                    <Field label="Custom meeting code (optional)">
                      <input
                        name="customCode"
                        placeholder="Leave blank to generate a code"
                        maxLength={64}
                        autoComplete="off"
                      />
                    </Field>
                  )}
                  {config.creationRequiresKey && (
                    <Field label="Creation key">
                      <input
                        name="creationKey"
                        type="password"
                        required
                        autoComplete="off"
                      />
                    </Field>
                  )}
                  <div className="form-footer">
                    <span>
                      <Icon name="lock" size={15} />
                      Guests wait for admission
                    </span>
                    <Button className="primary" disabled={busy} type="submit">
                      {busy ? "Creating…" : "Create meeting"}
                      <Icon name="arrow" size={17} />
                    </Button>
                  </div>
                </form>
              </section>
            )}
            <div className="right-column">
              <section className="card join-card">
                <div className="card-title">
                  <div className="feature-icon secondary">
                    <Icon name="link" />
                  </div>
                  <div>
                    <h2>Join a room</h2>
                    <p>Use a meeting code or direct link.</p>
                  </div>
                </div>
                <form onSubmit={join} className="form-stack">
                  <Field label="Meeting code or link">
                    <input
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value)}
                      placeholder="Paste a meeting code or link"
                      required
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Button type="submit" className="full-width">
                    Continue
                    <Icon name="arrow" size={17} />
                  </Button>
                </form>
              </section>
              <section className="access-card">
                <div className="access-graphic">
                  <Icon name="settings" size={27} />
                  <span className="graphic-line" />
                  <Icon name="users" size={27} />
                  <span className="graphic-line" />
                  <Icon name="lock" size={27} />
                </div>
                <h3>Room controls</h3>
                <div className="access-row">
                  <Icon name="check" size={15} />
                  Admit guests from the waiting room
                </div>
                <div className="access-row">
                  <Icon name="check" size={15} />
                  Manage microphone and camera access
                </div>
                <div className="access-row">
                  <Icon name="check" size={15} />
                  Lock the room and remove participants
                </div>
                <div className="access-divider" />
                <span className="muted">
                  Recording starts only when enabled by the host.
                </span>
              </section>
            </div>
          </div>
          <footer className="dashboard-footer">
            <span>{config.branding?.footerText || config.brandName}</span>
            {config.branding?.supportUrl ? (
              <a
                href={config.branding.supportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {config.branding.supportLabel || "Support"}
              </a>
            ) : (
              <span>Guests join without an account</span>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}

function Meeting({
  code,
  hostEntry,
  config,
}: {
  code: string;
  hostEntry: boolean;
  config: Config;
}) {
  const [state, setState] = useState<MeetingState>();
  const [needsJoin, setNeedsJoin] = useState(false);
  const [error, setError] = useState("");
  const [hostError, setHostError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const hostToken = useRef(hostEntry ? initialHostToken : "");
  const [bootstrapping, setBootstrapping] = useState(
    Boolean(hostToken.current),
  );
  const exchange = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (!bootstrapping) return;
    initialHostToken = "";
    exchange.current ??= api(meetingPath(code, "/host"), {
      token: hostToken.current,
    });
    exchange.current
      .then(() => {
        hostToken.current = "";
        setBootstrapping(false);
      })
      .catch(async (e) => {
        try {
          const current = await api<MeetingState>(meetingPath(code, "/state"));
          if (current.me.role === "host") {
            hostToken.current = "";
            setState(current);
            setBootstrapping(false);
            return;
          }
        } catch {}
        setHostError(messageOf(e));
        exchange.current = null;
        setBootstrapping(false);
      });
  }, [code, bootstrapping]);
  useEffect(() => {
    if (bootstrapping || hostError) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<MeetingState>(
          meetingPath(code, "/state"),
          undefined,
          undefined,
          controller.signal,
        );
        setState(data);
        setNeedsJoin(false);
        setError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setNeedsJoin(true);
          setState(undefined);
        } else {
          const pending = await scheduledMeetingPending(
            config,
            code,
            e instanceof ApiError ? e.status : 0,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setError(pending ? "Meeting has not started" : messageOf(e));
        }
      }
      if (!controller.signal.aborted) timeout = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [code, refresh, bootstrapping, hostError]);
  if (hostError)
    return (
      <Center>
        <Logo name={config.brandName} />
        <Notice>{hostError}</Notice>
        <Button
          onClick={() => {
            setHostError("");
            setBootstrapping(true);
          }}
        >
          Retry host entry
        </Button>
        <Button onClick={() => navigate("/")}>{homeLabel()}</Button>
      </Center>
    );
  if (needsJoin)
    return (
      <Prejoin
        config={config}
        code={code}
        onJoin={() => {
          setNeedsJoin(false);
          setRefresh((value) => value + 1);
        }}
      />
    );
  if (!state)
    return (
      <Center>
        <Logo name={config.brandName} />
        {error ? (
          <>
            <Notice>{error}</Notice>
            <Button onClick={() => setRefresh((v) => v + 1)}>Try again</Button>
            <Button onClick={() => navigate("/")}>{homeLabel()}</Button>
          </>
        ) : (
          <>
            <div className="spinner" />
            <p>
              {bootstrapping ? "Opening host session…" : "Opening meeting…"}
            </p>
          </>
        )}
      </Center>
    );
  if (
    state.me.status === "kicked" ||
    state.me.status === "banned" ||
    state.me.status === "left" ||
    state.meeting.ended
  )
    return (
      <Center>
        <Logo name={config.brandName} />
        <div className="status-icon">
          <Icon name="exit" size={30} />
        </div>
        <h1>
          {state.meeting.ended
            ? "Meeting ended"
            : state.me.status === "banned"
              ? "Meeting access removed"
              : state.me.status === "kicked"
                ? "Removed from meeting"
                : "You left the meeting"}
        </h1>
        <p className="muted">
          {state.me.status === "banned"
            ? "The host has blocked access to this meeting."
            : state.me.status === "kicked"
              ? "The host removed this session. You can request admission again."
              : state.meeting.title}
        </p>
        {state.meeting.ended && state.meeting.cleanupPending && (
          <Notice kind="info">Meeting connections are still closing.</Notice>
        )}
        {state.me.status === "kicked" && !state.meeting.ended && (
          <Button onClick={() => setNeedsJoin(true)}>Request admission</Button>
        )}
        <Button className="primary" onClick={() => navigate("/")}>
          {homeLabel()}
        </Button>
      </Center>
    );
  if (state.me.status === "waiting")
    return (
      <Center>
        <Logo name={config.brandName} />
        <div className="waiting-visual">
          <span className="avatar">{initials(state.me.name)}</span>
          <span className="waiting-dot" />
        </div>
        <p className="eyebrow">WAITING ROOM</p>
        <h1>{state.meeting.title}</h1>
        <p className="muted">
          The host will admit you when the meeting is ready.
        </p>
        <div className="joining-as">
          Joining as <strong>{state.me.name}</strong>
        </div>
        <DeviceCheck />
        {error && <Notice>{error}</Notice>}
        <Button
          onClick={async () => {
            try {
              await api(meetingPath(code, "/leave"), {});
              navigate("/");
            } catch (e) {
              setError(messageOf(e));
            }
          }}
        >
          Leave waiting room
        </Button>
      </Center>
    );
  return (
    <Conference
      config={config}
      state={state}
      networkError={error}
      refresh={() => setRefresh((v) => v + 1)}
    />
  );
}

function Prejoin({
  config,
  code,
  onJoin,
}: {
  config: Config;
  code: string;
  onJoin: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api(meetingPath(code, "/join"), {
        name: data.get("name"),
        password: data.get("password"),
      });
      onJoin();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="prejoin-page">
      <header>
        <Logo name={config.brandName} />
        <a
          href={homeHref()}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          {homeLabel()}
        </a>
      </header>
      <div className="prejoin-grid">
        <DeviceCheck />
        <section className="prejoin-form">
          <p className="eyebrow">JOIN MEETING</p>
          <h1>Enter the waiting room</h1>
          <p className="code-text">{code}</p>
          <form onSubmit={submit} className="form-stack">
            <Field label="Display name">
              <input
                name="name"
                autoComplete="name"
                maxLength={80}
                required
                autoFocus
              />
            </Field>
            <Field label="Meeting password">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </Field>
            {error && <Notice>{error}</Notice>}
            <Button
              type="submit"
              className="primary full-width"
              disabled={busy}
            >
              {busy ? "Joining…" : "Request to join"}
              <Icon name="arrow" size={17} />
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}

function Conference({
  config,
  state,
  networkError,
  refresh,
}: {
  config: Config;
  state: MeetingState;
  networkError: string;
  refresh: () => void;
}) {
  const [panel, setPanel] = useState<
    "participants" | "chat" | "recordings" | "breakouts" | "phone" | null
  >(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const boardViews = useRef(new Map<string, Viewport>());
  const [audioSignals, setAudioSignals] = useState<Map<string, AudioSignal>>(
    new Map(),
  );
  const chatButton = useRef<HTMLButtonElement>(null);
  const chatRead = useRef(new ChatUnread());
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [unreadChat, setUnreadChat] = useState(0);
  const chatRoom = `${state.meeting.code}:${state.me.id}:${state.me.breakoutId ?? "main"}`;
  useEffect(() => {
    setUnreadChat(
      chatRead.current.update(
        chatRoom,
        state.messages,
        state.me.id,
        panel === "chat",
      ),
    );
  }, [chatRoom, state.messages, state.me.id, panel]);
  function closePanel() {
    if (panel === "chat") chatButton.current?.focus();
    setPanel(null);
  }
  const [mediaControlsTarget, setMediaControlsTarget] =
    useState<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [issuedCredentials, setCredentials] = useState<{
    token: string;
    url: string;
    version: number;
  }>();
  const credentials =
    issuedCredentials?.version === state.me.mediaVersion &&
    !state.me.enforcementPending
      ? issuedCredentials
      : undefined;
  const [mediaError, setMediaError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const host = state.me.role === "host";
  const usage = host ? state.meeting.usage : undefined;
  const quotaNotice =
    usage === null
      ? "Usage is unavailable. Check the portal for status."
      : usage?.blocked
        ? "New connections are paused. Check usage in the portal."
        : usage &&
            usage.participantSeconds.limit !== null &&
            usage.participantSeconds.used >=
              usage.participantSeconds.limit * 0.8
          ? "Monthly time allowance is nearly used."
          : "";
  const code = state.meeting.code;
  const admitted = state.participants.filter((p) => p.status === "admitted");
  const waiting = state.participants.filter((p) => p.status === "waiting");
  useEffect(() => {
    if (!config.mediaAvailable || state.me.enforcementPending) return;
    const controller = new AbortController();
    setMediaError("");
    setCredentials(undefined);
    api<{ token: string; url: string }>(
      meetingPath(code, "/media"),
      {},
      undefined,
      controller.signal,
    )
      .then((value) => {
        const url = new URL(value.url, location.href);
        if (url.protocol === "http:") url.protocol = "ws:";
        if (url.protocol === "https:") url.protocol = "wss:";
        const expectedOrigin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
        if (url.origin !== expectedOrigin || !["/", ""].includes(url.pathname))
          throw new Error(
            "Media endpoint must use the same-origin signaling gateway.",
          );
        setCredentials({
          ...value,
          url: url.href,
          version: state.me.mediaVersion,
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setMediaError(messageOf(e));
      });
    return () => controller.abort();
  }, [
    code,
    config.mediaAvailable,
    attempt,
    state.me.mediaVersion,
    state.me.breakoutId,
    state.me.enforcementPending,
  ]);
  async function mutate(path: string, body: unknown = {}, method?: string) {
    setError("");
    setBusy(true);
    try {
      await api(meetingPath(code, path), body, method);
      refresh();
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(
        `${config.meetingOrigin || location.origin}/join/${encodeURIComponent(code)}`,
      );
      setNotice(
        `Meeting link copied. Code: ${code}. Share the password separately.`,
      );
      setTimeout(() => setNotice(""), 6000);
    } catch {
      setNotice(
        `Meeting link: ${config.meetingOrigin || location.origin}/join/${encodeURIComponent(code)}`,
      );
    }
  }
  const boardScope = `${code}:${state.me.breakoutId ?? "main"}`;
  const board = (
    <Whiteboard
      key={boardScope}
      code={code}
      host={host}
      scope={boardScope}
      viewportStore={boardViews.current}
    />
  );
  const stage = (
    <>
      <div className="stage-content">
        {credentials ? (
          <MediaStage
            me={state.me}
            participants={state.participants}
            mode={state.meeting.mode}
            boardOpen={boardOpen}
            signals={audioSignals}
            setSignals={setAudioSignals}
            board={board}
          />
        ) : boardOpen ? (
          board
        ) : (
          <div className="offline-stage">
            <span className="stage-avatar">{initials(state.me.name)}</span>
            <h2>{state.me.name}</h2>
            <span>
              {!config.mediaAvailable
                ? "Audio and video are not configured"
                : mediaError
                  ? "Audio and video unavailable"
                  : state.me.enforcementPending
                    ? "Applying host controls…"
                    : "Connecting audio and video…"}
            </span>
            {mediaError && (
              <>
                <p>{mediaError}</p>
                <Button onClick={() => setAttempt((v) => v + 1)}>
                  Retry connection
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="stage-footer">
        <div className="meeting-caption">
          <Icon name="lock" size={14} />
          {state.meeting.breakouts?.find((r) => r.id === state.me.breakoutId)
            ?.name || "Main room"}{" "}
          · {state.meeting.locked ? "Meeting locked" : "Waiting room enabled"}
          {state.meeting.deadlineAt && (
            <span>
              · Ends at{" "}
              <time dateTime={new Date(state.meeting.deadlineAt).toISOString()}>
                {new Date(state.meeting.deadlineAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </span>
          )}
          {state.me.breakoutId && (
            <button
              className="return-main"
              onClick={() => void mutate("/return-main")}
            >
              Return to main
            </button>
          )}
        </div>
      </div>
    </>
  );
  const roomContent = (
    <>
      <div className="meeting-workspace">
        <main className="meeting-stage">
          {credentials ? (
            <LiveKitRoom
              key={`${attempt}-${state.me.mediaVersion}`}
              token={credentials.token}
              serverUrl={credentials.url}
              connect
              audio={false}
              video={false}
              options={roomOptions}
              connectOptions={connectionOptions}
              onConnected={() => setMediaError("")}
              onError={(e) => setMediaError(e.message)}
              onDisconnected={() =>
                setMediaError(
                  "Media disconnected. Reconnect to request fresh access.",
                )
              }
            >
              <RoomAudioRenderer />
              <StartAudio label="Enable meeting audio" />
              {mediaError && (
                <div className="media-error">
                  <span>{mediaError}</span>
                  <Button onClick={() => setAttempt((v) => v + 1)}>
                    Reconnect
                  </Button>
                </div>
              )}
              {stage}
              {mediaControlsTarget &&
                createPortal(
                  <MediaControls me={state.me} />,
                  mediaControlsTarget,
                )}
            </LiveKitRoom>
          ) : (
            stage
          )}
        </main>
        {panel && (
          <aside
            className="meeting-panel"
            aria-labelledby="meeting-panel-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closePanel();
              }
            }}
          >
            <div className="panel-header">
              <h2 id="meeting-panel-title">
                {panel === "participants"
                  ? "Participants"
                  : panel === "chat"
                    ? "Meeting chat"
                    : panel === "breakouts"
                      ? "Breakout rooms"
                      : panel === "phone"
                        ? "Phone access"
                        : "Recordings"}
                {panel === "participants" && (
                  <span className="count">{admitted.length}</span>
                )}
              </h2>
              <button
                className="icon-button"
                onClick={closePanel}
                aria-label="Close panel"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            {panel === "participants" ? (
              <Participants
                state={state}
                signals={audioSignals}
                busy={busy}
                openPhone={
                  host && config.phoneAvailable
                    ? () => setPanel("phone")
                    : undefined
                }
                action={(id, data) =>
                  mutate(`/participants/${encodeURIComponent(id)}/action`, data)
                }
              />
            ) : panel === "chat" ? (
              <Chat
                key={chatRoom}
                state={state}
                text={chatDrafts[chatRoom] ?? ""}
                setText={(update) =>
                  setChatDrafts((drafts) => ({
                    ...drafts,
                    [chatRoom]:
                      typeof update === "function"
                        ? update(drafts[chatRoom] ?? "")
                        : update,
                  }))
                }
                send={(text) => mutate("/messages", { text })}
                busy={busy}
              />
            ) : panel === "breakouts" ? (
              <Breakouts state={state} busy={busy} mutate={mutate} />
            ) : panel === "phone" && host && config.phoneAvailable ? (
              <PhoneAccessPanel key={code} code={code} />
            ) : (
              <Recordings state={state} config={config} refresh={refresh} />
            )}
          </aside>
        )}
        {panel === null && unreadChat > 0 && (
          <button className="chat-alert" onClick={() => setPanel("chat")}>
            <Icon name="chat" size={18} />
            <span>
              {unreadChat} new {unreadChat === 1 ? "message" : "messages"}
            </span>
            <span className="chat-alert-action">Open chat</span>
          </button>
        )}
      </div>
      <footer className="meeting-bottom">
        <span className="session-role">
          {host
            ? "Host"
            : state.me.role === "viewer"
              ? "Viewer"
              : "Participant"}
          <span> · {state.me.name}</span>
          <SpeakingBadge
            surface="dock"
            name={state.me.name}
            signal={audioSignals.get(participantMediaIdentity(state.me))}
          />
        </span>
        <div className="meeting-dock">
          <div className="stage-controls">
            <div className="media-controls-slot" ref={setMediaControlsTarget}>
              {!credentials && (
                <>
                  <Button
                    disabled
                    aria-label="Microphone unavailable"
                    title="Microphone unavailable"
                  >
                    <Icon name="mic-off" />
                    <span>Microphone</span>
                  </Button>
                  <Button
                    disabled
                    aria-label="Camera unavailable"
                    title="Camera unavailable"
                  >
                    <Icon name="camera-off" />
                    <span>Camera</span>
                  </Button>
                  <Button
                    disabled
                    aria-label="Screen sharing unavailable"
                    title="Screen sharing unavailable"
                  >
                    <Icon name="screen" />
                    <span>Share screen</span>
                  </Button>
                </>
              )}
            </div>
            <Button
              className="leave-button"
              aria-label={host ? "End meeting" : "Leave meeting"}
              title={host ? "End meeting" : "Leave meeting"}
              disabled={busy}
              onClick={() => {
                if (host) {
                  if (window.confirm("End this meeting for everyone?"))
                    void mutate("/end");
                } else {
                  void mutate("/leave");
                }
              }}
            >
              <Icon name="exit" />
              <span>{host ? "End" : "Leave"}</span>
            </Button>
          </div>
          <div className="panel-tabs">
            <button
              className={boardOpen ? "selected" : ""}
              aria-label={boardOpen ? "Close whiteboard" : "Open whiteboard"}
              title={boardOpen ? "Close whiteboard" : "Open whiteboard"}
              aria-pressed={boardOpen}
              onClick={() => setBoardOpen((open) => !open)}
            >
              <Icon name="pen" />
              <span>Whiteboard</span>
            </button>
            <button
              className={panel === "participants" ? "selected" : ""}
              aria-label="Participants"
              title="Participants"
              aria-pressed={panel === "participants"}
              onClick={() =>
                setPanel(panel === "participants" ? null : "participants")
              }
            >
              <Icon name="users" />
              <span>Participants</span>
              {host && waiting.length > 0 && <b>{waiting.length}</b>}
            </button>
            <button
              ref={chatButton}
              className={panel === "chat" ? "selected" : ""}
              aria-label={
                unreadChat
                  ? `Chat, ${unreadChat} unread ${unreadChat === 1 ? "message" : "messages"}`
                  : "Chat"
              }
              title="Chat"
              aria-pressed={panel === "chat"}
              onClick={() => setPanel(panel === "chat" ? null : "chat")}
            >
              <Icon name="chat" />
              <span>Chat</span>
              {unreadChat > 0 && (
                <b aria-hidden="true">{unreadChat > 99 ? "99+" : unreadChat}</b>
              )}
            </button>
            <span className="sr-only" role="status">
              {panel !== "chat" && unreadChat > 0
                ? `${unreadChat} unread chat ${unreadChat === 1 ? "message" : "messages"}`
                : ""}
            </span>
            {host && (
              <button
                className={panel === "breakouts" ? "selected" : ""}
                aria-label="Breakout rooms"
                title="Breakout rooms"
                aria-pressed={panel === "breakouts"}
                onClick={() =>
                  setPanel(panel === "breakouts" ? null : "breakouts")
                }
              >
                <Icon name="grid" />
                <span>Breakouts</span>
              </button>
            )}
            {host && (
              <button
                className={panel === "recordings" ? "selected" : ""}
                aria-label="Recordings"
                title="Recordings"
                aria-pressed={panel === "recordings"}
                onClick={() =>
                  setPanel(panel === "recordings" ? null : "recordings")
                }
              >
                <Icon name="record" />
                <span>Recordings</span>
              </button>
            )}
          </div>
        </div>
      </footer>
    </>
  );
  return (
    <div className="conference">
      <header className="meeting-header">
        <Logo name={config.brandName} small />
        <div className="meeting-title">
          <h1>{state.meeting.title}</h1>
          <span>
            {state.meeting.mode === "webinar" ? "Webinar" : "Meeting"}
            <i /> {admitted.length}{" "}
            {admitted.length === 1 ? "participant" : "participants"}
          </span>
        </div>
        <div className="meeting-header-actions">
          {state.meeting.recordingActive && (
            <span className="recording-status">
              <span />
              Recording
            </span>
          )}
          <Button
            onClick={() => void copyInvite()}
            aria-label="Copy meeting invitation"
            title="Copy meeting invitation"
          >
            <Icon name="link" size={17} />
            <span>Invite</span>
          </Button>
          {host && (
            <Button
              className={state.meeting.locked ? "lock-active" : ""}
              aria-label={
                state.meeting.locked ? "Unlock meeting" : "Lock meeting"
              }
              title={state.meeting.locked ? "Unlock meeting" : "Lock meeting"}
              disabled={busy}
              onClick={() =>
                void mutate("", { locked: !state.meeting.locked }, "PATCH")
              }
            >
              <Icon name={state.meeting.locked ? "lock" : "unlock"} size={17} />
              <span>{state.meeting.locked ? "Unlock" : "Lock"}</span>
            </Button>
          )}
        </div>
      </header>
      {(error || networkError || notice || quotaNotice) && (
        <div className="room-notices">
          {(error || networkError) && <Notice>{error || networkError}</Notice>}
          {notice && <Notice kind="info">{notice}</Notice>}
          {quotaNotice && <Notice kind="info">{quotaNotice}</Notice>}
        </div>
      )}
      <div className="meeting-session">{roomContent}</div>
    </div>
  );
}

function MediaStage({
  me,
  participants,
  mode,
  boardOpen,
  board,
  signals,
  setSignals,
}: {
  me: Participant;
  participants: Participant[];
  mode: "meeting" | "webinar";
  boardOpen: boolean;
  board: ReactNode;
  signals: Map<string, AudioSignal>;
  setSignals: (signals: Map<string, AudioSignal>) => void;
}) {
  const room = useRoomContext();
  const [page, setPage] = useState(0);
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const connection = useConnectionState();
  const selection = selectStage(
    tracks.map((track) => ({
      key: `${track.participant.identity}:${track.source}:${isTrackReference(track) ? track.publication.trackSid : "placeholder"}`,
      mediaIdentity: track.participant.identity,
      source:
        track.source === Track.Source.ScreenShare
          ? ("screen_share" as const)
          : ("camera" as const),
      track,
    })),
    participants,
    { localId: me.id, mode, breakoutId: me.breakoutId },
    page,
  );
  const visible = selection.visible.map(({ track }) => track);
  const selectedVideoIds = (boardOpen ? [] : visible)
    .filter(isTrackReference)
    .map((track) => track.publication.trackSid)
    .sort()
    .join(",");
  const eligibleIds = [...selection.eligibleIds].sort().join(",");
  const allowedAudioIds = participants
    .filter(
      (participant) =>
        selection.eligibleIds.has(participantMediaIdentity(participant)) &&
        participant.audioAllowed,
    )
    .map(participantMediaIdentity)
    .sort()
    .join(",");
  const otherSpeakers = offscreenSpeakers(
    participants,
    signals,
    selection.eligibleIds,
    new Set(visible.map((track) => track.participant.identity)),
    boardOpen,
    me.id,
  );
  useEffect(() => {
    const stop = observeAudioSignals(
      room,
      new Set(eligibleIds.split(",")),
      new Set(allowedAudioIds.split(",")),
      setSignals,
    );
    return () => {
      stop();
      setSignals(new Map());
    };
  }, [room, eligibleIds, allowedAudioIds, setSignals]);
  useEffect(() => {
    const selected = new Set(selectedVideoIds.split(","));
    const eligible = new Set(eligibleIds.split(","));
    const apply = () => {
      const publications = [...room.remoteParticipants.values()].flatMap(
        (participant) =>
          [...participant.trackPublications.values()].map((publication) => ({
            publication,
            participant,
          })),
      );
      const wanted = ({
        publication,
        participant,
      }: (typeof publications)[number]) =>
        eligible.has(participant.identity) &&
        (publication.kind === Track.Kind.Audio ||
          selected.has(publication.trackSid));
      // Drop the previous page first, then request only the visible video page.
      for (const entry of publications)
        if (!wanted(entry) && entry.publication.isDesired)
          entry.publication.setSubscribed(false);
      for (const entry of publications)
        if (wanted(entry) && !entry.publication.isDesired)
          entry.publication.setSubscribed(true);
    };
    apply();
    const events = [
      RoomEvent.Connected,
      RoomEvent.Reconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
    ];
    for (const event of events) room.on(event, apply);
    return () => {
      for (const event of events) room.off(event, apply);
    };
  }, [room, selectedVideoIds, eligibleIds]);
  return (
    <>
      <div className="connection-label">
        <span className={connection === "connected" ? "connected" : ""} />
        {connection === "connected" ? "Connected" : connection}
        {otherSpeakers.length > 0 && (
          <div
            className="other-speakers"
            title={otherSpeakers
              .map((participant) => participant.name)
              .join(", ")}
          >
            Speaking:{" "}
            {otherSpeakers.map((participant) => participant.name).join(", ")}
          </div>
        )}
        {selection.pageCount > 1 && (
          <nav className="video-pagination" aria-label="Video pages">
            <button
              disabled={selection.page === 0}
              onClick={() => setPage(selection.page - 1)}
              aria-label="Previous video page"
            >
              Previous
            </button>
            <span>
              Page {selection.page + 1} of {selection.pageCount}
            </span>
            <button
              disabled={selection.page + 1 >= selection.pageCount}
              onClick={() => setPage(selection.page + 1)}
              aria-label="Next video page"
            >
              Next
            </button>
          </nav>
        )}
      </div>
      {boardOpen ? (
        board
      ) : (
        <>
          <div
            className={`video-grid ${visible.some((track) => track.source === Track.Source.ScreenShare) ? "has-screen" : ""}`}
            data-tile-count={visible.length}
            style={
              {
                "--tile-columns":
                  visible.length <= 1
                    ? 1
                    : visible.length <= 4
                      ? 2
                      : visible.length <= 9
                        ? 3
                        : 4,
              } as CSSProperties
            }
          >
            {visible.map((track) => {
              const signal = signals.get(track.participant.identity);
              const name =
                participants.find(
                  (participant) =>
                    participantMediaIdentity(participant) ===
                    track.participant.identity,
                )?.name ||
                track.participant.name ||
                "Participant";
              return (
                <div
                  className={`video-tile ${track.source === Track.Source.ScreenShare ? "screen-tile" : ""} ${signal?.speaking ? "is-speaking" : ""}`}
                  key={`${track.participant.identity}-${track.source}-${isTrackReference(track) ? track.publication.trackSid : "placeholder"}`}
                >
                  {isTrackReference(track) && !track.publication.isMuted ? (
                    <VideoTrack trackRef={track} manageSubscription={false} />
                  ) : (
                    <div className="tile-placeholder">
                      <span className="stage-avatar">{initials(name)}</span>
                    </div>
                  )}
                  <div className="tile-caption">
                    <span className="tile-name" title={name}>
                      {name}
                      {track.participant.isLocal ? " (you)" : ""}
                      {track.source === Track.Source.ScreenShare
                        ? " · Screen"
                        : ""}
                    </span>
                    <SpeakingBadge surface="tile" name={name} signal={signal} />
                  </div>
                </div>
              );
            })}
          </div>
          {visible.length === 0 && (
            <div className="empty-stage">
              {mode === "webinar"
                ? "Waiting for a presenter"
                : "Waiting for participants"}
            </div>
          )}
        </>
      )}
    </>
  );
}

function MediaControls({ me }: { me: Participant }) {
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();
  const [error, setError] = useState("");
  const audioAllowed = me.role !== "viewer" && me.audioAllowed;
  const videoAllowed = me.role !== "viewer" && me.videoAllowed;
  const microphoneAction = !audioAllowed
    ? "Microphone blocked by host"
    : isMicrophoneEnabled
      ? "Mute microphone"
      : "Unmute microphone";
  const cameraAction = !videoAllowed
    ? "Camera blocked by host"
    : isCameraEnabled
      ? "Turn camera off"
      : "Turn camera on";
  const shareAction = !videoAllowed
    ? "Screen sharing blocked by host"
    : isScreenShareEnabled
      ? "Stop sharing"
      : "Share screen";
  useEffect(() => {
    if (!audioAllowed)
      void localParticipant
        .setMicrophoneEnabled(false)
        .catch((e) => setError(messageOf(e)));
  }, [localParticipant, audioAllowed]);
  useEffect(() => {
    if (!videoAllowed) {
      void localParticipant
        .setCameraEnabled(false)
        .catch((e) => setError(messageOf(e)));
      void localParticipant
        .setScreenShareEnabled(false)
        .catch((e) => setError(messageOf(e)));
    }
  }, [localParticipant, videoAllowed]);
  return (
    <>
      {error && (
        <span className="device-error" role="alert">
          {error}
        </span>
      )}
      <fieldset className="media-control-guard" disabled={!audioAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.Microphone}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={microphoneAction}
          aria-label={microphoneAction}
        >
          <Icon
            name={audioAllowed && isMicrophoneEnabled ? "mic" : "mic-off"}
          />
          <span>
            {!audioAllowed
              ? "Mic blocked"
              : isMicrophoneEnabled
                ? "Mute"
                : "Unmute"}
          </span>
        </TrackToggle>
      </fieldset>
      <fieldset className="media-control-guard" disabled={!videoAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.Camera}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={cameraAction}
          aria-label={cameraAction}
        >
          <Icon
            name={videoAllowed && isCameraEnabled ? "video" : "camera-off"}
          />
          <span>
            {!videoAllowed
              ? "Camera blocked"
              : isCameraEnabled
                ? "Stop video"
                : "Start video"}
          </span>
        </TrackToggle>
      </fieldset>
      <fieldset className="media-control-guard" disabled={!videoAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.ScreenShare}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={shareAction}
          aria-label={shareAction}
        >
          <Icon name="screen" />
          <span>{isScreenShareEnabled ? "Stop sharing" : "Share screen"}</span>
        </TrackToggle>
      </fieldset>
    </>
  );
}

function PhoneAccessPanel({ code }: { code: string }) {
  const [access, setAccess] = useState<PhoneAccess>();
  const [pin, setPin] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setAccess(undefined);
    setPin(undefined);
    api<PhoneAccess>(
      meetingPath(code, "/phone"),
      undefined,
      undefined,
      controller.signal,
    )
      .then((details) => {
        if (!controller.signal.aborted) setAccess(details);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [code, attempt]);
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    setPin(undefined);
    try {
      if (enabled) {
        const issued = await api<PhoneAccess & { pin: string }>(
          meetingPath(code, "/phone"),
          {},
        );
        const { pin: nextPin, ...details } = issued;
        setAccess(details);
        setPin(nextPin);
      } else {
        await api(meetingPath(code, "/phone"), {}, "DELETE");
        setAccess(
          (current) =>
            current && { ...current, enabled: false, locator: undefined },
        );
        setNotice("Phone access disabled.");
      }
    } catch (e) {
      setError(messageOf(e));
      setAccess(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setError("Copy failed. Select the value and copy it manually.");
    }
  }
  return (
    <div className="panel-scroll">
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="info">{notice}</Notice>}
      {!access ? (
        busy ? (
          <p>Loading phone access…</p>
        ) : (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        )
      ) : (
        <div className="form-stack">
          <strong>
            {access.enabled ? "Phone access enabled" : "Phone access disabled"}
          </strong>
          {access.dialInNumber && (
            <Field label="Dial-in number">
              <input readOnly value={access.dialInNumber} />
            </Field>
          )}
          {access.sipAddress && (
            <Field label="SIP address">
              <input readOnly value={access.sipAddress} />
            </Field>
          )}
          {!access.dialInNumber && !access.sipAddress && (
            <Notice kind="info">
              No dial-in number or SIP address is configured.
            </Notice>
          )}
          {access.enabled && access.locator && (
            <>
              <Field label="Phone meeting code">
                <input readOnly value={access.locator} />
              </Field>
              <Button
                className="small"
                onClick={() => void copy(access.locator!, "Phone meeting code")}
              >
                Copy phone code
              </Button>
              {pin ? (
                <>
                  <Field label="Access PIN">
                    <input readOnly autoComplete="off" value={pin} />
                  </Field>
                  <Button
                    className="small"
                    onClick={() => void copy(pin, "Access PIN")}
                  >
                    Copy PIN
                  </Button>
                  <p className="panel-note">
                    Save this PIN before closing the panel. It is shown only
                    when generated.
                  </p>
                </>
              ) : (
                <p className="panel-note">
                  Regenerate phone access to issue a new PIN.
                </p>
              )}
            </>
          )}
          <Button
            className="small primary"
            disabled={busy}
            onClick={() => {
              if (
                !access.enabled ||
                window.confirm(
                  "Regenerate phone access? This ends existing phone calls and replaces the phone code and PIN.",
                )
              )
                void change(true);
            }}
          >
            {access.enabled ? "Regenerate phone access" : "Enable phone access"}
          </Button>
          {access.enabled && (
            <Button
              className="small"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Disable phone access and end existing phone calls?",
                  )
                )
                  void change(false);
              }}
            >
              Disable phone access
            </Button>
          )}
          <p className="panel-note">
            Callers enter the phone code and PIN, then wait for host admission.
            Caller ID does not verify identity.
          </p>
        </div>
      )}
    </div>
  );
}

function Participants({
  state,
  signals,
  busy,
  action,
  openPhone,
}: {
  state: MeetingState;
  signals: Map<string, AudioSignal>;
  busy: boolean;
  action: (id: string, data: object) => Promise<boolean>;
  openPhone?: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ban, setBan] = useState<Participant | null>(null);
  const [banIp, setBanIp] = useState(false);
  const [banDevice, setBanDevice] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const host = state.me.role === "host";
  const webinar = state.meeting.webinar;
  const stageFull = !!webinar && webinar.presenters >= webinar.presenterLimit;
  const audienceFull = !!webinar && webinar.viewers >= webinar.viewerLimit;
  const waiting = state.participants.filter((p) => p.status === "waiting");
  const admitted = state.participants.filter((p) => p.status === "admitted");
  return (
    <div className="panel-scroll">
      {openPhone && (
        <Button className="small full-width" onClick={openPhone}>
          Phone access
        </Button>
      )}
      {host && waiting.length > 0 && (
        <section className="waiting-list">
          <div className="section-label">
            WAITING ROOM <span>{waiting.length}</span>
          </div>
          {waiting.map((p) => (
            <div className="participant-row" key={p.id}>
              <span className="avatar small-avatar">{initials(p.name)}</span>
              <div className="participant-name">
                <strong>{p.name}</strong>
                <small>
                  {p.transport === "phone"
                    ? "Phone caller · Waiting for admission"
                    : "Waiting for admission"}
                </small>
              </div>
              <Button
                className="small primary"
                disabled={busy || state.meeting.locked}
                title={
                  state.meeting.locked
                    ? "Unlock the meeting to admit guests"
                    : "Admit guest"
                }
                onClick={() => void action(p.id, { action: "admit" })}
              >
                Admit
              </Button>
              {p.transport === "phone" ? (
                <Button
                  className="small"
                  disabled={busy}
                  onClick={() => void action(p.id, { action: "kick" })}
                >
                  End call
                </Button>
              ) : (
                <button
                  className="icon-button"
                  aria-label={`Remove ${p.name} from waiting room`}
                  disabled={busy}
                  onClick={() => void action(p.id, { action: "kick" })}
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {host && webinar && (
        <p className="panel-note">
          Stage: {webinar.presenters}/{webinar.presenterLimit} · Audience:{" "}
          {webinar.viewers}/{webinar.viewerLimit}
        </p>
      )}
      <div className="section-label">IN MEETING</div>
      {admitted.map((p) => (
        <div className="participant-entry" key={p.id}>
          <div
            className={`participant-row ${signals.get(participantMediaIdentity(p))?.speaking ? "is-speaking" : ""}`}
          >
            <span
              className={`avatar small-avatar ${p.role === "host" ? "host-avatar" : ""}`}
            >
              {initials(p.name)}
            </span>
            <div className="participant-name">
              <strong>
                {p.name}
                {p.id === state.me.id ? " (you)" : ""}
              </strong>
              <SpeakingBadge
                surface="list"
                name={p.name}
                signal={signals.get(participantMediaIdentity(p))}
              />
              <small>
                {p.transport === "phone" && "Phone caller · "}
                {p.role === "host"
                  ? "Host"
                  : p.role === "viewer"
                    ? "Viewer"
                    : state.meeting.mode === "webinar"
                      ? "Presenter"
                      : "Participant"}
              </small>
              {p.transport === "phone" && (
                <small>
                  {!p.audioAllowed
                    ? "Speaking blocked"
                    : p.phone?.muted
                      ? "Muted"
                      : "Speaking allowed"}
                </small>
              )}
              {p.phone?.handRaised && <small>Hand raised</small>}
            </div>
            <span
              className={`permission-icon ${p.audioAllowed ? "" : "blocked"}`}
              title={
                p.audioAllowed ? "Microphone permitted" : "Microphone blocked"
              }
            >
              <Icon name="mic" size={14} />
            </span>
            {p.transport !== "phone" && (
              <span
                className={`permission-icon ${p.videoAllowed ? "" : "blocked"}`}
                title={p.videoAllowed ? "Camera permitted" : "Camera blocked"}
              >
                <Icon name="video" size={14} />
              </span>
            )}
            {host && p.id !== state.me.id && (
              <button
                className="icon-button"
                aria-expanded={expanded === p.id}
                aria-label={`Controls for ${p.name}`}
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
              >
                <Icon name="more" size={18} />
              </button>
            )}
          </div>
          {expanded === p.id && (
            <div className="participant-actions">
              <button
                disabled={busy || p.role === "viewer"}
                title={
                  p.role === "viewer"
                    ? p.transport === "phone"
                      ? "Invite to stage to allow speaking"
                      : "Invite to stage to allow devices"
                    : undefined
                }
                onClick={() =>
                  void action(p.id, {
                    action: p.audioAllowed ? "block-audio" : "allow-audio",
                  })
                }
              >
                {p.transport === "phone"
                  ? p.audioAllowed
                    ? "Mute and block speaking"
                    : "Allow speaking"
                  : p.audioAllowed
                    ? "Mute and block microphone"
                    : "Allow microphone"}
              </button>
              {p.transport !== "phone" && (
                <button
                  disabled={busy || p.role === "viewer"}
                  title={
                    p.role === "viewer"
                      ? "Invite to stage to allow devices"
                      : undefined
                  }
                  onClick={() =>
                    void action(p.id, {
                      action: p.videoAllowed ? "block-video" : "allow-video",
                    })
                  }
                >
                  {p.videoAllowed
                    ? "Turn off and block camera"
                    : "Allow camera"}
                </button>
              )}
              {p.transport === "phone" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setRenaming(p.id);
                    setName(p.name);
                  }}
                >
                  Rename caller
                </button>
              )}
              {renaming === p.id && (
                <form
                  className="form-stack"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (
                      await action(p.id, {
                        action: "rename",
                        name: name.trim(),
                      })
                    )
                      setRenaming(null);
                  }}
                >
                  <Field label="Caller name">
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={80}
                      required
                    />
                  </Field>
                  <div className="button-row">
                    <button type="submit" disabled={busy || !name.trim()}>
                      Save name
                    </button>
                    <button type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              {state.meeting.mode === "webinar" && (
                <button
                  disabled={
                    busy || (p.role === "viewer" ? stageFull : audienceFull)
                  }
                  title={
                    p.role === "viewer" && stageFull
                      ? "Stage is full"
                      : p.role !== "viewer" && audienceFull
                        ? "Audience is full"
                        : undefined
                  }
                  onClick={() =>
                    void action(p.id, {
                      action: p.role === "viewer" ? "promote" : "demote",
                    })
                  }
                >
                  {p.role === "viewer" ? "Invite to stage" : "Move to audience"}
                </button>
              )}
              <button
                className="danger-text"
                disabled={busy}
                onClick={() => void action(p.id, { action: "kick" })}
              >
                {p.transport === "phone" ? "End call" : "Kick from meeting"}
              </button>
              {(p.transport !== "phone" || p.phone?.canBanCallerId) && (
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() => {
                    setBan(p);
                    setBanIp(false);
                    setBanDevice(true);
                  }}
                >
                  {p.transport === "phone"
                    ? "Block caller ID…"
                    : "Ban from meeting…"}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {host && (
        <p className="panel-note">
          Permission changes reconnect media. Participants choose when to turn
          allowed devices back on.
          {admitted.some((p) => p.transport === "phone") &&
            " Allowing a phone caller to speak leaves the call muted until the caller unmutes."}
        </p>
      )}
      {ban && (
        <div className="ban-form">
          <h3>
            {ban.transport === "phone" ? "Block caller ID" : "Ban"}: {ban.name}
          </h3>
          {ban.transport === "phone" ? (
            <>
              <p>
                End this call and block calls using this caller ID for this
                meeting.
              </p>
              <small>
                Caller ID can be changed or spoofed. This does not verify or
                permanently block a person.
              </small>
            </>
          ) : (
            <>
              <p>
                This participant cannot rejoin this meeting with the current
                session.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={banDevice}
                  onChange={(e) => setBanDevice(e.target.checked)}
                />
                Also block this browser
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={banIp}
                  onChange={(e) => setBanIp(e.target.checked)}
                />
                Also block this IP address
              </label>
              <small>
                Browser data can be cleared. IP blocking can affect others on
                the same network.
              </small>
            </>
          )}
          <div className="button-row">
            <Button className="small" onClick={() => setBan(null)}>
              Cancel
            </Button>
            <Button
              className="small danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await action(
                    ban.id,
                    ban.transport === "phone"
                      ? { action: "ban", banCallerId: true }
                      : { action: "ban", banIp, banDevice },
                  )
                )
                  setBan(null);
              }}
            >
              {ban.transport === "phone"
                ? "Block caller ID"
                : "Ban participant"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Breakouts({
  state,
  busy,
  mutate,
}: {
  state: MeetingState;
  busy: boolean;
  mutate: (path: string, body?: unknown, method?: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [broadcast, setBroadcast] = useState("");
  const [sent, setSent] = useState(false);
  const rooms = [
    { id: "", name: "Main room" },
    ...(state.meeting.breakouts || []),
  ];
  const admitted = state.participants.filter((p) => p.status === "admitted");
  return (
    <div className="panel-scroll breakout-panel">
      <form
        className="breakout-create"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await mutate("/breakouts", { name: name.trim() })) setName("");
        }}
      >
        <Field label="New room name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            placeholder="Room name"
          />
        </Field>
        <Button
          className="small primary"
          type="submit"
          disabled={busy || !name.trim()}
        >
          Create
        </Button>
      </form>
      {rooms.map((room) => (
        <section className="breakout-room" key={room.id}>
          <header>
            <h3>{room.name}</h3>
            <Button
              className="small"
              disabled={busy || (state.me.breakoutId || "") === room.id}
              onClick={() =>
                void mutate("/move", {
                  participantId: state.me.id,
                  breakoutId: room.id || null,
                })
              }
            >
              {(state.me.breakoutId || "") === room.id
                ? "Current room"
                : "Visit room"}
            </Button>
          </header>
          {admitted
            .filter((p) => (p.breakoutId || "") === room.id)
            .map((p) => (
              <div className="breakout-assign" key={p.id}>
                <span>
                  {p.name}
                  {p.id === state.me.id ? " (you)" : ""}
                </span>
                <label>
                  <span className="sr-only">Room for {p.name}</span>
                  <select
                    disabled={busy || p.transport === "phone"}
                    title={
                      p.transport === "phone"
                        ? "Phone callers cannot move to breakout rooms yet"
                        : undefined
                    }
                    value={p.breakoutId || ""}
                    onChange={(e) =>
                      void mutate("/move", {
                        participantId: p.id,
                        breakoutId: e.target.value || null,
                      })
                    }
                  >
                    {rooms.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          {!admitted.some((p) => (p.breakoutId || "") === room.id) && (
            <p className="breakout-empty">No participants</p>
          )}
        </section>
      ))}
      {(state.meeting.breakouts?.length || 0) > 0 && (
        <Button
          className="small full-width"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Close all breakout rooms and return everyone to the main room?",
              )
            )
              void mutate("/close-breakouts");
          }}
        >
          Close all breakout rooms
        </Button>
      )}
      <form
        className="breakout-broadcast"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await mutate("/broadcast", { text: broadcast.trim() })) {
            setBroadcast("");
            setSent(true);
          }
        }}
      >
        <Field label="Message all rooms">
          <textarea
            value={broadcast}
            onChange={(e) => {
              setBroadcast(e.target.value);
              setSent(false);
            }}
            maxLength={2000}
            rows={3}
            placeholder="Message to all participants"
            required
          />
        </Field>
        <Button
          className="small"
          type="submit"
          disabled={busy || !broadcast.trim()}
        >
          Send to all rooms
        </Button>
        {sent && <Notice kind="success">Message sent to all rooms.</Notice>}
      </form>
      <p className="panel-note">
        Moving rooms reconnects audio and video. Participants choose when to
        turn their devices back on.
        {admitted.some((p) => p.transport === "phone") &&
          " Phone callers stay in the main room."}
      </p>
    </div>
  );
}

function Recordings({
  state,
  config,
  refresh,
}: {
  state: MeetingState;
  config: Config;
  refresh: () => void;
}) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [verified, setVerified] = useState(
    Boolean(state.meeting.hostEmailVerified),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const code = state.meeting.code;
  const active = state.recordings.some((r) =>
    ["starting", "recording", "active", "stopping"].includes(r.status),
  );
  const recordingUsage = state.meeting.usage?.recordingSeconds;
  const phonePresent = state.participants.some(
    (participant) =>
      participant.transport === "phone" &&
      (["waiting", "admitted"].includes(participant.status) ||
        !!participant.enforcementPending),
  );
  async function request(suffix: string, body: object = {}, method?: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await api<{ url?: string; expiresAt?: string }>(
        meetingPath(code, suffix),
        body,
        method,
      );
      refresh();
      return result;
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel-scroll recordings-panel">
      {state.meeting.recordingAvailable !== false && (
        <label className="switch-row">
          <span>
            <strong>Allow recording</strong>
            <small>Recording is off until started.</small>
          </span>
          <input
            aria-label="Allow recording"
            type="checkbox"
            role="switch"
            checked={state.meeting.recordingAllowed}
            disabled={busy}
            onChange={(e) =>
              void request("", { recordingAllowed: e.target.checked }, "PATCH")
            }
          />
        </label>
      )}
      {state.meeting.recordingAvailable === false ? (
        <Notice kind="info">Recording is available on paid plans.</Notice>
      ) : !config.recordingAvailable ? (
        <Notice kind="info">
          Recording is not configured. An administrator must configure encrypted
          storage and email delivery before recordings can start.
        </Notice>
      ) : (
        <>
          <div className="section-label">HOST EMAIL</div>
          {verified || state.meeting.hostEmailVerified ? (
            <div className="verified">
              <Icon name="check" size={17} />
              Email verified
            </div>
          ) : (
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await request(
                  sent ? "/verify-email" : "/host-email",
                  sent ? { otp } : { email },
                );
                if (result) {
                  if (sent) setVerified(true);
                  else {
                    setSent(true);
                    setNotice("Verification code sent.");
                  }
                }
              }}
            >
              {!sent ? (
                <Field label="Email address">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </Field>
              ) : (
                <Field label="Verification code">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    maxLength={12}
                  />
                </Field>
              )}
              <Button className="small" disabled={busy} type="submit">
                {sent ? "Verify email" : "Send verification code"}
              </Button>
              {sent && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSent(false)}
                >
                  Change email address
                </button>
              )}
            </form>
          )}
          <p className="panel-note">
            Download links expire after 24 hours. A separate password is emailed
            to the verified host.
          </p>
          {recordingUsage && (
            <p className="panel-note" role="status">
              {(recordingUsage.available / 60).toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}{" "}
              recording minutes available this month.
              {recordingUsage.reserved > 0 &&
                " Active or stopping jobs reserve time until they finish."}{" "}
              Includes recorder startup and shutdown.
            </p>
          )}
          {phonePresent && (
            <Notice kind="info">
              Recording is unavailable while phone callers are connected. Phone
              recording announcements are not configured.
            </Notice>
          )}
          <Button
            className="primary full-width"
            disabled={
              busy ||
              !state.meeting.recordingAllowed ||
              !(verified || state.meeting.hostEmailVerified) ||
              phonePresent ||
              active
            }
            onClick={() => void request("/recordings")}
          >
            <Icon name="record" size={17} />
            Start recording
          </Button>
        </>
      )}
      {error && <Notice>{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {link && (
        <div className="recording-link">
          <strong>Download link</strong>
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            Open download
          </a>
          <small>
            Expires {new Date(link.expiresAt).toLocaleString()}. The password
            was sent by email.
          </small>
          <Button
            className="small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  new URL(link.url, location.origin).href,
                );
                setNotice("Download link copied.");
              } catch {
                setNotice("Select the download link to copy it.");
              }
            }}
          >
            Copy link
          </Button>
        </div>
      )}
      <div className="section-label">MEETING RECORDINGS</div>
      {state.recordings.length === 0 && (
        <div className="empty-panel">
          <Icon name="record" size={28} />
          <p>No recordings</p>
        </div>
      )}
      {state.recordings.map((recording) => (
        <div className="recording-item" key={recording.id}>
          <div>
            <strong>
              {new Date(recording.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </strong>
            <span className="status-pill">{recording.status}</span>
          </div>
          {recording.error && <Notice>{recording.error}</Notice>}
          {["starting", "recording", "active"].includes(recording.status) ? (
            <Button
              className="small"
              disabled={busy}
              onClick={() =>
                void request(
                  `/recordings/${encodeURIComponent(recording.id)}/stop`,
                )
              }
            >
              Stop recording
            </Button>
          ) : ["ready", "completed"].includes(recording.status) ? (
            <div className="button-row">
              <Button
                className="small"
                disabled={busy}
                onClick={async () => {
                  const result = await request(
                    `/recordings/${encodeURIComponent(recording.id)}/link`,
                  );
                  if (result?.url && result.expiresAt)
                    setLink({ url: result.url, expiresAt: result.expiresAt });
                }}
              >
                Create 24-hour link
              </Button>
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={async () => {
                  if (
                    await request(
                      `/recordings/${encodeURIComponent(recording.id)}/revoke`,
                    )
                  ) {
                    setLink(undefined);
                    setNotice("Download links revoked.");
                  }
                }}
              >
                Revoke links
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Download({ code, config }: { code: string; config: Config }) {
  const [token] = useState(initialDownloadToken);
  useEffect(() => {
    initialDownloadToken = "";
  }, []);
  const [target] = useState(() => `recording-download-${crypto.randomUUID()}`);
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  function downloadResult() {
    // An attachment streams to the browser's downloads; only errors load the frame.
    try {
      if (!requested) return;
      const text = frame.current?.contentDocument?.body?.textContent;
      if (!text) throw new Error("Unreadable download response");
      const result: unknown = JSON.parse(text);
      setError(
        result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
          ? result.error
          : "Download failed. Try again.",
      );
    } catch {
      setError("Download failed. Check your connection and try again.");
    }
    setRequested(false);
  }
  if (!token)
    return (
      <Center>
        <Logo name={config.brandName} />
        <Icon name="link" size={30} />
        <h1>Reopen the download link</h1>
        <p className="muted">
          This tab no longer contains the download key. Reopen the original
          24-hour link from the meeting.
        </p>
        <Button onClick={() => navigate("/")}>{homeLabel()}</Button>
      </Center>
    );
  return (
    <Center>
      <Logo name={config.brandName} />
      <div className="status-icon">
        <Icon name="download" size={30} />
      </div>
      <h1>Download recording</h1>
      <p className="muted">
        Enter the password emailed to the host. Use the browser with the active
        host session.
      </p>
      <form
        action={`/api/meetings/${encodeURIComponent(code)}/download`}
        method="post"
        target={target}
        onSubmit={() => {
          setError("");
          setRequested(true);
        }}
        className="form-stack full-width"
      >
        <input type="hidden" name="token" value={token} />
        <Field label="Recording password">
          <input
            type="password"
            name="password"
            autoComplete="off"
            maxLength={256}
            required
          />
        </Field>
        {error && <Notice>{error}</Notice>}
        {requested && (
          <Notice kind="success">
            Download requested. Check your browser’s downloads.
          </Notice>
        )}
        <Button className="primary full-width" type="submit">
          <Icon name="download" size={17} />
          Download recording
        </Button>
      </form>
      <iframe
        ref={frame}
        name={target}
        title="Recording download result"
        sandbox="allow-same-origin allow-forms allow-downloads"
        onLoad={downloadResult}
        hidden
      />
      <small className="muted">
        Links last up to 24 hours, within the recording’s seven-day retention.
        The server decrypts the video for download. The downloaded MP4 has no
        password protection.
      </small>
      {config.edition === "hosted" && (
        <small className="muted">
          Each accepted download uses the full file size from the monthly
          allowance, including retries and interrupted downloads.
        </small>
      )}
    </Center>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
