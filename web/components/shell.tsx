"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHealth } from "./health";

const NAV = [
  { href: "/intervene", label: "Intervene" },
  { href: "/concept", label: "Concepts" },
  { href: "/search", label: "Search" },
  { href: "/steer", label: "Steer" },
  { href: "/contagion", label: "Contagion tracer" },
  { href: "/setup", label: "Setup" },
];

export function Header() {
  const path = usePathname();
  const { health, status } = useHealth();
  const compute = status === "down" ? "API unreachable" : !health ? "Connecting" : health.gpu ? `API connected. ${health.gpu_count} GPU` : "API connected. No GPU";
  return (
    <header className="border-b bg-header">
      <div className="flex min-h-14 flex-wrap items-center gap-x-5 gap-y-1 px-6 py-2">
        <Link href="/intervene" className="flex items-center gap-2.5 text-text no-underline">
          <span aria-hidden="true" className="grid grid-cols-[7px_7px] gap-0.5">
            <span className="size-[7px] rounded-[2px] bg-text" />
            <span className="size-[7px] rounded-[2px] bg-text" />
            <span className="size-[7px] rounded-[2px] bg-text" />
            <span className="size-[7px] rounded-[2px] bg-accent" />
          </span>
          <span className="text-[14px] font-semibold tracking-[0.04em]">MOSAIC Atlas</span>
        </Link>
        <nav aria-label="Atlas" className="flex flex-wrap gap-0.5">
          {NAV.map((n) => {
            const on = path === n.href || path.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={`inline-flex h-9 items-center px-2.5 text-[14px] no-underline ${
                  on ? "font-medium text-text shadow-[inset_0_-2px_0_var(--color-text)]" : "rounded-md text-text-2 hover:bg-chip hover:text-text"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <span className="flex-1" />
        <span className="chip" data-testid="api-status">{compute}</span>
      </div>
    </header>
  );
}

export function SelectorBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b bg-bg-raised">
      <div className="mx-auto flex w-full max-w-[1392px] flex-wrap items-center gap-x-2.5 gap-y-2 px-6 py-2.5">{children}</div>
    </div>
  );
}

export function Main({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <main className={`mx-auto box-border flex w-full flex-1 flex-col gap-4 px-6 pt-5 pb-16 ${narrow ? "max-w-[1120px]" : "max-w-[1392px]"}`}>
      {children}
    </main>
  );
}
