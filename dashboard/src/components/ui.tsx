import Link from "next/link";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function Card({ title, subtitle, actions, children, className }: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-hairline bg-surface p-4", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

/** Section heading with its controls in one row above the content they scope. */
export function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

/** A series key that mirrors its mark: a short line for lines/areas, a block for bars. */
export function Swatch({ color, kind = "rect" }: { color: string; kind?: "rect" | "line" }) {
  return kind === "line" ? (
    <span aria-hidden className="inline-block h-0.5 w-3.5 shrink-0 rounded-full" style={{ background: color }} />
  ) : (
    <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
  );
}

export function StatTile({ label, value, sub, swatch }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  swatch?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-ink-2">
        {swatch && <Swatch color={swatch} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** A row of links acting as a segmented control (state lives in the URL). */
export function SegmentedLinks({ items }: { items: { href: string; label: string; active: boolean }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-hairline bg-surface p-0.5 text-sm">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1",
            item.active ? "bg-ink font-medium text-surface" : "text-ink-2 hover:bg-grid/60",
          )}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

/** ⚠ + label - status never relies on colour alone. */
export function StatusNote({ tone, children }: { tone: "warning" | "critical"; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink" role="status">
      <span aria-hidden className={tone === "critical" ? "text-critical" : "text-warning"}>⚠</span>
      {children}
    </div>
  );
}
