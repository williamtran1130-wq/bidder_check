/** A lightweight fallback shared by server and client rendering. */
export function PageLoading({
  label = "Loading workspace…",
  size = "page",
}: {
  label?: string;
  size?: "page" | "section" | "screen";
}) {
  return (
    <div role="status" className={`page-loading page-loading--${size}`}>
      <div className="page-loading-track" aria-hidden="true">
        <span />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
