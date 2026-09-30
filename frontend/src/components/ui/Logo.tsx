export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      style={{ fontSize: size }}
      className="font-[family-name:var(--font-logo)] font-bold leading-none tracking-[0.06em] text-ink"
      aria-label="Outbox"
    >
      ONB
    </span>
  );
}
