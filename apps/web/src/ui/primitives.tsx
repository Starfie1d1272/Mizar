import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import './ui.css';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  variant?: 'primary' | 'secondary';
};

export function Button({
  loading = false,
  variant = 'secondary',
  disabled,
  children,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`mizar-button ${className}`}
      data-variant={variant}
    >
      {loading ? (
        <>
          <span aria-hidden="true" className="mizar-spinner" />
          处理中…
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function IconButton({
  label,
  children,
  ...props
}: Omit<ButtonProps, 'loading'> & { label: string }) {
  return (
    <Button {...props} aria-label={label} className={`mizar-icon-button ${props.className ?? ''}`}>
      {children}
    </Button>
  );
}

export function Field({
  label,
  message,
  tone = 'info',
  id: suppliedId,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; message?: string; tone?: StatusTone }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className="mizar-field" data-tone={tone}>
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-invalid={tone === 'danger' || props['aria-invalid'] || undefined}
        aria-describedby={
          [props['aria-describedby'], message ? `${id}-message` : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
      {message && <span id={`${id}-message`}>{message}</span>}
    </div>
  );
}

export function Checkbox({
  label,
  message,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; message?: string }) {
  const id = useId();
  return (
    <div className="mizar-field">
      <label className="mizar-checkbox">
        <input
          {...props}
          type="checkbox"
          aria-describedby={message ? `${id}-help` : props['aria-describedby']}
        />
        <span>{label}</span>
      </label>
      {message ? <span id={`${id}-help`}>{message}</span> : null}
    </div>
  );
}

export function Select({
  label,
  message,
  id: suppliedId,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; message?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className="mizar-field">
      <label htmlFor={id}>{label}</label>
      <select
        {...props}
        id={id}
        aria-describedby={
          [props['aria-describedby'], message ? `${id}-message` : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
      >
        {children}
      </select>
      {message ? <span id={`${id}-message`}>{message}</span> : null}
    </div>
  );
}

export function Panel({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`mizar-panel ${className}`}>
      {children}
    </div>
  );
}
export function Divider() {
  return <hr className="mizar-divider" />;
}
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="mizar-status-pill" data-tone={tone}>
      {children}
    </span>
  );
}
export function StatusBanner({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <div
      className="mizar-status-banner"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Panel className="mizar-empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </Panel>
  );
}

/** Native modal owns focus trapping, Escape, background inertness and focus return. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  className,
  canClose,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  canClose?: () => boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={['mizar-dialog', className].filter(Boolean).join(' ')}
      onCancel={(event) => {
        if (canClose && !canClose()) event.preventDefault();
      }}
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClose={onClose}
    >
      <h2 id={id}>{title}</h2>
      {children}
      <Button
        onClick={() => {
          if (!canClose || canClose()) ref.current?.close();
        }}
      >
        关闭
      </Button>
    </dialog>
  );
}
