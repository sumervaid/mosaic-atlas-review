import type { ContagionEdge, ContagionNode } from "./types";

/** The same test the API uses for its prune parameter. */
export function pruneEdges(edges: ContagionEdge[], prune: number): ContagionEdge[] {
  return edges.filter((e) => Math.abs(e.weight) >= prune);
}

/** Messages that reached an agent at this step, and what this message did to its readers. */
export function connections(node: ContagionNode, edges: ContagionEdge[]): { input: ContagionEdge[]; output: ContagionEdge[] } {
  return {
    input: edges.filter((e) => e.to === node.agent && e.step + 1 === node.step),
    output: edges.filter((e) => e.message_id === node.id),
  };
}

/** A recipient only yields a reading if it speaks on the next step. Those recipients come first. */
export function rankRecipients(node: ContagionNode, nodes: ContagionNode[]): { id: string; speaksNext: boolean }[] {
  const next = new Set(nodes.filter((n) => n.step === node.step + 1).map((n) => n.agent));
  return (node.recipients ?? [])
    .map((id) => ({ id, speaksNext: next.has(id) }))
    .sort((a, b) => Number(b.speaksNext) - Number(a.speaksNext));
}

/** The API repeats a reading once per branch it appears in. One row per distinct message is enough to read. */
export function uniqueRows<T extends { activation: number; agent: string; step: number; text: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.activation}|${r.agent}|${r.step}|${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The API reports a missing key path as "No file at .." because an empty path resolves to the current folder. */
export function readableProblems(problems: string[], keyPath: string): string[] {
  if (keyPath.trim()) return problems;
  return problems.map((p) => readableDetail(p, keyPath));
}

/** The same wording, inside the joined text the machine endpoints send on a 422. */
export function readableDetail(detail: string, keyPath: string): string {
  if (keyPath.trim()) return detail;
  return detail.replace(/^No file at \.\.(?=\s|$)/, "Point to a Google Cloud service account key file.");
}
