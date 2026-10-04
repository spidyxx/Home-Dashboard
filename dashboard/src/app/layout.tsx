import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home",
  description: "Self-hosted home dashboard",
};

// One entry per area of the house; more join as data sources are added.
const NAV = [{ href: "/", label: "Energy" }];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-hairline bg-surface">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="font-semibold text-ink">Home</Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="rounded-md px-3 py-1 font-medium text-ink hover:bg-grid/60">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
