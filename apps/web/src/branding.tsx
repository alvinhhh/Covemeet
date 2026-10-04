import { useState, type FormEvent } from "react";
import { api, messageOf, type Branding, type Config } from "./api";
import { Icon } from "./icons";
import { brandLogo } from "./brand";

const defaultBranding: Branding = {
  brandName: "Covemeet",
  headline: "Start or join a meeting",
  description: "",
  accentColor: "#166e60",
  backgroundColor: "#f5f6f2",
  font: "sans",
  borderRadius: "rounded",
  logoUrl: "",
  backgroundUrl: "",
  supportUrl: "",
  supportLabel: "Support",
  footerText: "",
  showHostButton: true,
};

export function BrandingEditor({
  config,
  onSaved,
  onBack,
}: {
  config: Config;
  onSaved: (config: Config) => void;
  onBack: () => void;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Branding>({
    ...defaultBranding,
    ...config.branding,
  });
  function update<K extends keyof Branding>(field: K, value: Branding[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setNotice("");
  }
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/admin/session", { creationKey: key });
      setAuthenticated(true);
      setKey("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/admin/branding", draft, "PATCH");
      const latest = await api<Config>("/config");
      onSaved(latest);
      setDraft({ ...defaultBranding, ...latest.branding });
      setNotice("Branding saved.");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(
    file: File | undefined,
    field: "logoUrl" | "backgroundUrl",
  ) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Upload a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Images must be no larger than 2 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(file);
      });
      const result = await api<{ url: string }>("/admin/assets", {
        mime: file.type,
        data,
      });
      update(field, result.url);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  if (!authenticated)
    return (
      <main className="center-page">
        <section className="center-card">
          <div className="status-icon">
            <Icon name="settings" size={28} />
          </div>
          <h1>Branding settings</h1>
          <p className="muted">
            Enter the installation creation key to manage branding.
          </p>
          <form className="form-stack full-width" onSubmit={signIn}>
            <label className="field">
              <span>Creation key</span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                required
                autoFocus
              />
            </label>
            {error && (
              <div role="alert" className="notice">
                {error}
              </div>
            )}
            <button className="button primary" disabled={busy} type="submit">
              {busy ? "Opening…" : "Open settings"}
            </button>
          </form>
          <button className="text-button" onClick={onBack}>
            Control panel
          </button>
        </section>
      </main>
    );
  return (
    <main className="branding-page">
      <header>
        <div>
          <p className="eyebrow">INSTALLATION SETTINGS</p>
          <h1>Branding</h1>
        </div>
        <button className="button" onClick={onBack}>
          <Icon
            name="arrow"
            size={17}
            style={{ transform: "rotate(180deg)" }}
          />
          Control panel
        </button>
      </header>
      <div className="branding-layout">
        <form className="branding-form card" onSubmit={save}>
          <h2>Page content</h2>
          <label className="field">
            <span>Brand name</span>
            <input
              value={draft.brandName}
              onChange={(e) => update("brandName", e.target.value)}
              required
              maxLength={60}
            />
          </label>
          <label className="field">
            <span>Page title</span>
            <input
              value={draft.headline}
              onChange={(e) => update("headline", e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              value={draft.description}
              onChange={(e) => update("description", e.target.value)}
              maxLength={300}
              rows={3}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.showHostButton}
              onChange={(e) => update("showHostButton", e.target.checked)}
            />
            Show meeting creation form on landing page
          </label>
          <div className="form-section-divider" />
          <h2>Appearance</h2>
          <div className="form-row">
            <label className="field">
              <span>Accent color</span>
              <div className="color-field">
                <input
                  type="color"
                  value={draft.accentColor}
                  onChange={(e) => update("accentColor", e.target.value)}
                />
                <input
                  value={draft.accentColor}
                  onChange={(e) => update("accentColor", e.target.value)}
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  required
                  aria-label="Accent color hex value"
                />
              </div>
            </label>
            <label className="field">
              <span>Background color</span>
              <div className="color-field">
                <input
                  type="color"
                  value={draft.backgroundColor}
                  onChange={(e) => update("backgroundColor", e.target.value)}
                />
                <input
                  value={draft.backgroundColor}
                  onChange={(e) => update("backgroundColor", e.target.value)}
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  required
                  aria-label="Background color hex value"
                />
              </div>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Font</span>
              <select
                value={draft.font}
                onChange={(e) =>
                  update("font", e.target.value as Branding["font"])
                }
              >
                <option value="sans">Sans serif</option>
                <option value="serif">Serif</option>
                <option value="system">System</option>
              </select>
            </label>
            <label className="field">
              <span>Corners</span>
              <select
                value={draft.borderRadius}
                onChange={(e) =>
                  update(
                    "borderRadius",
                    e.target.value as Branding["borderRadius"],
                  )
                }
              >
                <option value="square">Square</option>
                <option value="rounded">Rounded</option>
                <option value="pill">Pill</option>
              </select>
            </label>
          </div>
          <div className="upload-grid">
            {(["logoUrl", "backgroundUrl"] as const).map((field) => (
              <div className="upload-field" key={field}>
                <span>{field === "logoUrl" ? "Logo" : "Background image"}</span>
                {draft[field] ? (
                  <div className="upload-preview">
                    <img
                      src={draft[field]}
                      alt={
                        field === "logoUrl"
                          ? "Logo preview"
                          : "Background preview"
                      }
                    />
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() => update(field, "")}
                    >
                      Remove image
                    </button>
                  </div>
                ) : (
                  <div className="upload-empty">
                    <Icon
                      name={field === "logoUrl" ? "video" : "grid"}
                      size={24}
                    />
                    <span>No image</span>
                  </div>
                )}
                <label className="button small upload-button">
                  Upload image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={busy}
                    onChange={(e) => {
                      void upload(e.target.files?.[0], field);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            ))}
          </div>
          <small className="muted">
            PNG, JPEG, or WebP. Maximum 2 MB per image.
          </small>
          <div className="form-section-divider" />
          <h2>Footer</h2>
          <label className="field">
            <span>Footer text</span>
            <input
              value={draft.footerText || ""}
              onChange={(e) => update("footerText", e.target.value)}
              maxLength={150}
            />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Support link label</span>
              <input
                value={draft.supportLabel || ""}
                onChange={(e) => update("supportLabel", e.target.value)}
                maxLength={40}
              />
            </label>
            <label className="field">
              <span>Support URL</span>
              <input
                value={draft.supportUrl || ""}
                onChange={(e) => update("supportUrl", e.target.value)}
                type="url"
                placeholder="https://example.com/support"
                maxLength={500}
              />
            </label>
          </div>
          {error && (
            <div role="alert" className="notice">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice success">
              {notice}
            </div>
          )}
          <div className="branding-save">
            <button className="button primary" disabled={busy} type="submit">
              {busy ? "Saving…" : "Save branding"}
              <Icon name="check" size={17} />
            </button>
          </div>
        </form>
        <aside className="branding-preview">
          <div className="section-label">LANDING PAGE PREVIEW</div>
          <div
            className="preview-surface"
            style={{
              backgroundColor: draft.backgroundColor,
              fontFamily:
                draft.font === "serif"
                  ? "Georgia, serif"
                  : "system-ui, sans-serif",
              borderRadius:
                draft.borderRadius === "square"
                  ? 2
                  : draft.borderRadius === "pill"
                    ? 24
                    : 14,
              backgroundImage: draft.backgroundUrl
                ? `linear-gradient(${draft.backgroundColor}bb, ${draft.backgroundColor}bb),url(${JSON.stringify(draft.backgroundUrl)})`
                : undefined,
            }}
          >
            <div className="preview-brand">
              {brandLogo(draft.brandName, draft.logoUrl) ? (
                <img src={brandLogo(draft.brandName, draft.logoUrl)} alt="" />
              ) : (
                <span style={{ color: draft.accentColor }}>
                  <Icon name="video" size={24} />
                </span>
              )}
              <strong>{draft.brandName}</strong>
            </div>
            <h2>{draft.headline}</h2>
            {draft.description && <p>{draft.description}</p>}
            <div className="preview-form">
              <strong>Join a room</strong>
              <div>Meeting code or link</div>
              <span
                style={{
                  backgroundColor: draft.accentColor,
                  borderRadius:
                    draft.borderRadius === "square"
                      ? 2
                      : draft.borderRadius === "pill"
                        ? 30
                        : 6,
                }}
              >
                Continue <Icon name="arrow" size={14} />
              </span>
            </div>
            {draft.showHostButton && (
              <div className="preview-host">
                Create a room <Icon name="plus" size={15} />
              </div>
            )}
            <footer>
              {draft.footerText || draft.brandName}
              {draft.supportUrl && (
                <span>{draft.supportLabel || "Support"}</span>
              )}
            </footer>
          </div>
          <p className="panel-note">
            Branding applies to the landing page, waiting room, and meeting
            controls. Image uploads stay on this installation.
          </p>
        </aside>
      </div>
    </main>
  );
}
