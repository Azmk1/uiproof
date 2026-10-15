"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitBranch } from "lucide-react";
import { BrandMark } from "@/components/layout/brand-mark";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/", label: "Console" },
  { href: "/demo", label: "Fixtures" },
] as const;

const REPOSITORY_URL = "https://github.com/Azmk1/uiproof";

function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-5 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md py-1 pr-1 text-[15px] font-semibold tracking-[-0.02em]"
        >
          <BrandMark />
          <span>UIProof</span>
        </Link>
        <Badge variant="outline" className="hidden sm:inline-flex">
          phase 1
        </Badge>

        <nav aria-label="Primary" className="ml-auto flex items-center gap-1">
          {NAV_LINKS.map((link) => {
            const isActive = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors sm:px-3",
                  isActive
                    ? "bg-surface-muted text-ink"
                    : "text-ink-soft hover:bg-surface-muted hover:text-ink",
                )}
              >
                {link.label}
              </Link>
            );
          })}
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink md:inline-flex"
          >
            <GitBranch className="size-3.5" />
            Repository
          </a>
        </nav>

        <span className="ml-3 hidden items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1 sm:inline-flex">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-pass" />
          <span className="label-caps text-ink-soft">local engine</span>
        </span>
      </div>
    </header>
  );
}

export { SiteHeader, REPOSITORY_URL };
