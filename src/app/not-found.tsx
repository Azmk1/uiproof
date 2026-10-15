import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandMark } from "@/components/layout/brand-mark";

export default function NotFound() {
  return (
    <div className="pixel-grid flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.02em]">
        <BrandMark />
        UIProof
      </span>
      <p className="label-caps">404 · route not found</p>
      <h1 className="max-w-md text-2xl leading-tight font-semibold tracking-[-0.03em]">
        Nothing to screenshot here.
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-ink-soft">
        The console lives at <span className="font-mono">/</span> and the capturable fixtures live under{" "}
        <span className="font-mono">/demo</span>.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink/90"
      >
        <ArrowLeft className="size-4" />
        Back to the console
      </Link>
    </div>
  );
}
