import { useEffect, useRef, type ReactNode } from "react";
import "./dialogs.css";

export function Modal({
  title,
  close,
  busy = false,
  side = false,
  children,
}: {
  title: string;
  close: () => void;
  busy?: boolean;
  side?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={side ? "workspace-dialog ask-panel" : "workspace-dialog"}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="sheet-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          className="sheet-close"
          disabled={busy}
          onClick={close}
        >
          <span aria-hidden="true" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
