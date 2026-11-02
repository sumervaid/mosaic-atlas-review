import type { ForkProgress } from "./types";

export function progressShare(p: ForkProgress): number {
  if (p.status === "complete") return 1;
  const total = p.branches_total ?? 0;
  if (!total) return 0;
  const done = p.branches_done ?? 0;
  const partial = p.steps && p.branch ? Math.min(1, (p.branch_step ?? 0) / p.steps) : 0;
  return Math.min(1, (done + (done < total ? partial : 0)) / total);
}

export function progressText(p: ForkProgress): string {
  const total = p.branches_total ?? 0;
  const done = p.branches_done ?? 0;
  switch (p.status) {
    case "queued":
      return "Queued.";
    case "complete":
      return total ? `Complete. ${done} of ${total} branches done.` : "Complete.";
    case "failed":
      return p.error ? `The fork failed. ${p.error}` : "The fork failed. The API gave no reason.";
    case "unknown":
      return "The API does not know this fork. It may have restarted during the run.";
    default:
      if (!p.branch) return "Running up to the fork step and saving a snapshot.";
      return `Branch ${p.branch}, step ${p.branch_step ?? 0} of ${p.steps ?? "?"}. ${done} of ${total} branches done.`;
  }
}

export const isTerminal = (p: ForkProgress) => p.status === "complete" || p.status === "failed" || p.status === "unknown";
