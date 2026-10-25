import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "arrow"
  | "upload"
  | "download"
  | "play"
  | "pause"
  | "reset"
  | "chevron"
  | "plus"
  | "minus"
  | "fit"
  | "undo"
  | "trash"
  | "layout"
  | "people"
  | "compare"
  | "check"
  | "close"
  | "help"
  | "layers"
  | "route"
  | "heat"
  | "cursor"
  | "exit"
  | "clock"
  | "pin"
  | "video"
  | "external";
const paths: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />,
  play: <path d="m8 5 11 7-11 7Z" fill="currentColor" strokeWidth="1" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
  reset: <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
    </>
  ),
  undo: <path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12" />,
  trash: <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M9 12h12" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2" />
    </>
  ),
  compare: (
    <>
      <rect x="2" y="5" width="8" height="14" rx="1" />
      <rect x="14" y="5" width="8" height="14" rx="1" />
      <path d="M6 2v3m12 14v3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1-1.5 3m0 3h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8Zm-9 10 9 5 9-5M3 18l9 5 9-5" />
    </>
  ),
  route: (
    <>
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M5 16v-5a5 5 0 0 1 5-5h7" />
    </>
  ),
  heat: (
    <path d="M12 3c1 5 6 6 6 12a6 6 0 1 1-12 0c0-3 2-5 4-7 0 3 1 4 2 4s2-2 0-9Z" />
  ),
  cursor: <path d="m5 3 14 10-7 1-3 7Z" />,
  exit: <path d="M10 3H3v18h7M8 12h13m-5-5 5 5-5 5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  pin: <path d="m15 3 6 6-4 1-4 6-3-3-6 7m1-15 4-1 6 6-1 4-9-9Z" />,
  video: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-4v12l-6-4Z" /></>,
  external: <path d="M14 3h7v7m0-7L10 14M9 3H3v18h18v-6" />,
};
export default function Icon({
  name,
  size = 18,
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
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
