import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

// Drawer, modal and toast. A drawer or modal is a modal dialog: focus moves into it, Tab stays in it,
// Escape and the close button end it, and focus goes back to where it was.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Dialog({
  title,
  onClose,
  kind,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  kind: 'drawer' | 'modal';
  children: ReactNode;
  footer?: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    return () => back?.focus?.();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length === 0) return;
    const first = all[0] as HTMLElement;
    const last = all[all.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className={`ui-scrim${kind === 'modal' ? ' ui-scrim-center' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={kind === 'modal' ? 'ui-modal' : 'ui-drawer'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <div className="ui-ov-hd">
          <h2 id={id}>{title}</h2>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div>{children}</div>
        {footer ? <div className="ui-ph-acts">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A panel from the right, for details beside the page. Rendered only while `open`. */
export function Drawer(p: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!p.open) return null;
  return (
    <Dialog kind="drawer" title={p.title} onClose={p.onClose} footer={p.footer}>
      {p.children}
    </Dialog>
  );
}

/** A centred dialog that asks for one thing. Rendered only while `open`. */
export function Modal(p: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!p.open) return null;
  return (
    <Dialog kind="modal" title={p.title} onClose={p.onClose} footer={p.footer}>
      {p.children}
    </Dialog>
  );
}

export type ToastTone = 'ok' | 'warn' | 'bad';
interface ToastItem {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => undefined);
/** `toast('Saved')`: a short note in a polite live region; it goes after `ms` or when dismissed. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children, ms = 6000 }: { children: ReactNode; ms?: number }) {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, tone: ToastTone = 'ok') => {
      const id = next.current++;
      setItems((xs) => [...xs, { id, text, tone }]);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
    },
    [dismiss, ms],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ul className="ui-toasts" role="status" aria-live="polite" aria-label="Notifications">
        {items.map((t) => (
          <li key={t.id} className={`ui-toast${t.tone === 'ok' ? '' : ` ui-toast-${t.tone}`}`}>
            <span style={{ flex: 1 }}>{t.text}</span>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              aria-label={`Dismiss: ${t.text}`}
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </ToastContext.Provider>
  );
}
