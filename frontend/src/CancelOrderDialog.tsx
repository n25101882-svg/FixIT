import { useEffect, useRef } from "react";

export function CancelOrderDialog({ title, onConfirm, onDismiss }: {
  title: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const element = dialog.current!;
    const previous = opener.current;
    element.showModal();
    keep.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(":disabled")) previous.focus();
      else document.getElementById("orders-history-title")?.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} className="cancel-order-dialog" aria-labelledby="cancel-order-title"
      aria-describedby="cancel-order-description" onClose={() => { if (dialog.current && !dialog.current.open) onDismiss(); }}
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}>
      <button type="button" className="dialog-close secondary-button" aria-label="Закрити діалог" onClick={onDismiss}>×</button>
      <h2 id="cancel-order-title">Скасувати заявку?</h2>
      <p id="cancel-order-description">Заявку «{title}» буде скасовано. Повернути її у відкритий стан не можна.</p>
      <div className="dialog-actions">
        <button ref={keep} type="button" className="secondary-button" onClick={onDismiss}>Ні, залишити</button>
        <button type="button" className="primary-button" onClick={onConfirm}>Так, скасувати</button>
      </div>
    </dialog>
  );
}
