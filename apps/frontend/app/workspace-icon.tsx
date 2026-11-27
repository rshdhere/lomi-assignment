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
  plus: <path d="M12 5v14M5 12h14" />,
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
