/** Consistent loading / error / empty placeholder, used across every view. */
export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state-block">
      <div className="spinner" aria-label={label} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return <div className="error-block">{message}</div>;
}

export function EmptyBlock({ children }: { children: React.ReactNode }) {
  return <div className="state-block">{children}</div>;
}
