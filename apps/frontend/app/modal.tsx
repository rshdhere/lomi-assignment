import { useEffect, useRef, type ReactNode } from "react";
import "./dialogs.css";

export function Modal({
  title,
  close,
  busy = false,
  side = false,
  closing = false,
  onExit,
  children,
}: {
  title: string;
  close: () => void;
  busy?: boolean;
  side?: boolean;
  closing?: boolean;
  onExit?: () => void;
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
  useEffect(() => {
    if (!closing || !onExit) return;
    let active = true;
    const animations = ref.current?.getAnimations() ?? [];
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => {
      if (active) onExit();
    });
    return () => {
      active = false;
    };
  }, [closing, onExit]);

  return (
    <dialog
      ref={ref}
      className={side ? "workspace-dialog ask-panel" : "workspace-dialog"}
      data-closing={closing || undefined}
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
