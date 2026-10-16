import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Shortens a generated id (`run-…`, `bl-…`) for display without hiding which one it is. */
export function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 11)}…${id.slice(-4)}`;
}
