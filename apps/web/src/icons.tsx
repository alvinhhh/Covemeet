import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "video"
  | "mic"
  | "screen"
  | "users"
  | "chat"
  | "lock"
  | "unlock"
  | "arrow"
  | "plus"
  | "close"
  | "link"
  | "check"
  | "record"
  | "settings"
  | "grid"
  | "exit"
  | "download"
  | "mail"
  | "shield"
  | "more"
  | "camera-off";

const paths: Record<IconName, ReactNode> = {
  video: (
    <>
      <rect x="3" y="5" width="12" height="14" rx="3" />
      <path d="m15 9 6-3v12l-6-3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
    </>
  ),
  screen: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4m-4-11 4-4 4 4M12 6v7" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a4 4 0 0 1 3 4v2" />
    </>
  ),
  chat: (
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 9h10M7 13h7" />
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 7.5-2M12 14v3" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  plus: <path d="M12 4v16M4 12h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  link: (
    <>
      <path d="m10 13 4-4m-7 5-2 2a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4m-2 0a3 3 0 0 1 0-4l4-4a3 3 0 0 1 4 4l-2 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  record: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" fill="currentColor" />
      <circle cx="16" cy="12" r="2" fill="currentColor" />
      <circle cx="10" cy="18" r="2" fill="currentColor" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  exit: (
    <>
      <path d="M9 3H4v18h5M9 12h12m-5-5 5 5-5 5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  shield: <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 9 3 3 5-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  "camera-off": (
    <>
      <path d="m3 3 18 18M10 5h3a2 2 0 0 1 2 2v2l6-3v12l-4-2M15 15v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 1-1.7" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
