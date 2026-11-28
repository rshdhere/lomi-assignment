import type { ReactNode } from "react";

const shapes = {
  document: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4M9 12h6m-6 4h5" />
    </>
  ),
  folder: (
    <path d="M3 6a1.5 1.5 0 0 1 1.5-1.5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 8.5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.3 15.3 4.4 4.4" />
    </>
  ),
  sparkles: <path d="m10 4 2.2 6.1L18 12l-5.8 2.1L10 20l-2.2-5.9L2 12l5.8-1.9z M19 2l.9 2.5L22.5 5.5l-2.6.9L19 9l-.9-2.6-2.6-.9 2.6-1z" />,
  ask: (
    <>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5.5 3.5V17H6a2 2 0 0 1-2-2z" />
      <path d="M8 9h8m-8 3.5h5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4m-4 4 4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </>
  ),
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  uploadFile: (
    <path d="M5 2.5h9l5 5v14H5z M14 2.5v5h5 M12 18v-7m-3 3 3-3 3 3" />
  ),
  menu: <path d="M4 8h16M4 15h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m7 10 5 5 5-5" />,
} satisfies Record<string, ReactNode>;

export function WorkspaceIcon({ name }: { name: keyof typeof shapes }) {
  return (
    <svg
      className="workspace-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
