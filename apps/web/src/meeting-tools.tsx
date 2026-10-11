import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "./icons";

export function MeetingTools({
  buttonRef,
  notifications,
  children,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  notifications: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), [tabindex='0']",
      )
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const focusOutside = (event: FocusEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    // Device selectors use a portal; follow DOM focus and key events across it.
    const element = container.current;
    element?.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    return () => {
      element?.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open, buttonRef]);
  return (
    <div className="meeting-tools" ref={container}>
      <button
        ref={buttonRef}
        type="button"
        className="button"
        aria-label="More"
        title="More"
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={notifications ? `${id}-notifications` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" />
        <span>More</span>
        {notifications && (
          <b className="tools-notification" aria-hidden="true">
            •
          </b>
        )}
      </button>
      <span className="sr-only" role="status" id={`${id}-notifications`}>
        {notifications}
      </span>
      <div
        ref={panel}
        id={id}
        className="meeting-tools-panel"
        role="group"
        aria-label="Meeting tools"
        hidden={!open}
      >
        {children(close)}
      </div>
    </div>
  );
}
