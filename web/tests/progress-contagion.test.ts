import { describe, expect, it } from "vitest";
import { connections, pruneEdges, rankRecipients, readableDetail, readableProblems, uniqueRows } from "@/lib/contagion";
import { isTerminal, progressShare, progressText } from "@/lib/progress";
import type { ContagionEdge, ForkProgress } from "@/lib/types";

const p = (x: Partial<ForkProgress>): ForkProgress => ({ fork_id: "f", status: "running", ...x });

describe("fork progress", () => {
  it("counts finished branches and the current one", () => {
    expect(progressShare(p({ branches_done: 1, branches_total: 5, branch: "r0", branch_step: 4, steps: 8 }))).toBeCloseTo(0.3);
    expect(progressShare(p({ status: "complete", branches_done: 5, branches_total: 5 }))).toBe(1);
    expect(progressShare(p({ branches_total: 0 }))).toBe(0);
  });
  it("never passes 100 percent", () => {
    expect(progressShare(p({ branches_done: 5, branches_total: 5, branch: "x", branch_step: 8, steps: 8 }))).toBe(1);
  });
  it("describes each state in words", () => {
    expect(progressText(p({ status: "queued" }))).toBe("Queued.");
    expect(progressText(p({ branch: null }))).toContain("snapshot");
    expect(progressText(p({ branch: "r000-treatment", branch_step: 3, steps: 8, branches_done: 1, branches_total: 5 }))).toBe("Branch r000-treatment, step 3 of 8. 1 of 5 branches done.");
    expect(progressText(p({ status: "failed", error: "ValueError: boom" }))).toBe("The fork failed. ValueError: boom");
    expect(progressText(p({ status: "failed" }))).toContain("no reason");
  });
  it("stops at complete, failed, and unknown", () => {
    expect(isTerminal(p({ status: "complete" }))).toBe(true);
    expect(isTerminal(p({ status: "failed" }))).toBe(true);
    expect(isTerminal(p({ status: "unknown" }))).toBe(true);
    expect(isTerminal(p({ status: "running" }))).toBe(false);
  });
});

const edge = (x: Partial<ContagionEdge>): ContagionEdge => ({ message_id: "m0001-A", from: "A", to: "B", step: 1, feature: 3, weight: 0.5, replicates: 1, recipient_silent_without_message: 0, method: "message-ablation replay", ...x });

describe("contagion", () => {
  it("prunes on absolute weight, as the API does", () => {
    const edges = [edge({ weight: -0.5 }), edge({ weight: 0.1 })];
    expect(pruneEdges(edges, 0.5)).toHaveLength(1);
    expect(pruneEdges(edges, 0)).toHaveLength(2);
  });
  it("sorts edges into input and output for a node", () => {
    const e = edge({});
    const sender = { id: "m0001-A", agent: "A", step: 1, text: "" };
    const reader = { id: "m0002-B", agent: "B", step: 2, text: "" };
    expect(connections(sender, [e])).toEqual({ input: [], output: [e] });
    expect(connections(reader, [e])).toEqual({ input: [e], output: [] });
    expect(connections({ ...reader, step: 3 }, [e])).toEqual({ input: [], output: [] });
  });
  it("offers recipients who speak next first", () => {
    const node = { id: "m1", agent: "A", step: 1, text: "", recipients: ["B", "C"] };
    const ranked = rankRecipients(node, [node, { id: "m2", agent: "C", step: 2, text: "" }]);
    expect(ranked).toEqual([{ id: "C", speaksNext: true }, { id: "B", speaksNext: false }]);
  });
  it("drops repeated readings of one message", () => {
    const r = { activation: 1, agent: "A", step: 1, text: "x", config: "c" };
    expect(uniqueRows([r, { ...r }, { ...r, step: 2 }])).toHaveLength(2);
  });
});

describe("setup messages", () => {
  it("rewords the API's message for a missing key path, and only that", () => {
    expect(readableProblems(["No file at ..", "Set a Google Cloud project."], "")).toEqual(["Point to a Google Cloud service account key file.", "Set a Google Cloud project."]);
    expect(readableProblems(["No file at /tmp/key.json."], "/tmp/key.json")).toEqual(["No file at /tmp/key.json."]);
    expect(readableDetail("No file at .. Set a Google Cloud project.", "")).toBe("Point to a Google Cloud service account key file. Set a Google Cloud project.");
  });
});
