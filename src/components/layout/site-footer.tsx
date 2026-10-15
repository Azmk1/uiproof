import Link from "next/link";
import { REPOSITORY_URL } from "@/components/layout/site-header";

function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-5 py-6 text-xs text-ink-faint sm:flex-row sm:items-center lg:px-8">
        <p className="font-mono">
          UIProof 0.1.0 · playwright + pixelmatch · chromium
        </p>
        <p className="sm:ml-auto">
          Captures are limited to the local{" "}
          <Link href="/demo" className="font-mono text-ink-soft underline-offset-2 hover:underline">
            /demo
          </Link>{" "}
          fixtures.{" "}
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-soft underline-offset-2 hover:underline"
          >
            Source
          </a>
        </p>
      </div>
    </footer>
  );
}

export { SiteFooter };
