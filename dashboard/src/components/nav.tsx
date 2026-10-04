"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

// One entry per area of the house; more join as data sources are added.
const NAV = [
  { href: "/", label: "Energy" },
  { href: "/network", label: "Network" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-3 py-1 font-medium", active ? "bg-grid text-ink" : "text-ink-2 hover:bg-grid/60")}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
