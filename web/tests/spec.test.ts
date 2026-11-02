import { describe, expect, it } from "vitest";
import { buildSpec, canonicalSpec, defaultForm, formFromSpec } from "@/lib/spec";
import type { ExperimentConfig } from "@/lib/types";

const config: ExperimentConfig = { id: "test-256", description: "", model: { backend: "test", model_id: "test-tiny-gemma3" }, steps: 8, layer: 2, watch_features: [0, 1, 2, 3, 4, 5, 6, 7] };
const gpu: ExperimentConfig = { ...config, id: "gemma-256", model: { backend: "hf", model_id: "gemma-3-12b-it" }, layer: 32 };

describe("defaultForm", () => {
  it("starts the test model on a setting that reaches other agents", () => {
    const f = defaultForm(config);
    expect([f.op, f.vectorId, f.alpha, f.replicates, f.snapshotStep, f.watchFeature]).toEqual(["add", "test-vector", "300", "2", "1", 3]);
  });
  it("does not carry the test vector into a GPU experiment by default", () => {
    expect(defaultForm(gpu).op).toBe("clamp");
  });
});

describe("buildSpec", () => {
  it("builds the ForkSpec the API expects, with the experiment's own layer", () => {
    const { spec, problems } = buildSpec("test-256", config, ["A001"], defaultForm(config));
    expect(problems).toEqual([]);
    expect(spec).toEqual({
      experiment_id: "test-256",
      snapshot_step: 1,
      replicates: 2,
      shared_seeds: true,
      batch_invariant: true,
      watch_feature: 3,
      interventions: [{ agents: ["A001"], layer: 2, op: "add", feature: null, value: null, vector_id: "test-vector", alpha: 300, window: [1, null] }],
    });
    expect(buildSpec("gemma-256", gpu, ["A001"], defaultForm(gpu)).spec?.interventions[0].layer).toBe(32);
  });
  it("sends only what each operation needs", () => {
    const clamp = buildSpec("x", config, ["A"], { ...defaultForm(config), op: "clamp", feature: 2, value: "1.5" }).spec?.interventions[0];
    expect(clamp).toMatchObject({ op: "clamp", feature: 2, value: 1.5, vector_id: null, alpha: null });
    const ablate = buildSpec("x", config, ["A"], { ...defaultForm(config), op: "ablate", feature: 2 }).spec?.interventions[0];
    expect(ablate).toMatchObject({ op: "ablate", feature: 2, value: null, vector_id: null, alpha: null });
  });
  it("names each problem and builds nothing", () => {
    const f = defaultForm(config);
    expect(buildSpec("x", config, [], f).problems).toContain("Select at least one agent.");
    expect(buildSpec("x", config, ["A"], { ...f, alpha: "" }).problems).toContain("Add needs a coefficient.");
    expect(buildSpec("x", config, ["A"], { ...f, op: "clamp", value: "high" }).problems).toContain("Clamp needs a target value.");
    expect(buildSpec("x", config, ["A"], { ...f, replicates: "0" }).problems).toContain("Replicates must be at least 1.");
    expect(buildSpec("x", config, ["A"], { ...f, windowStart: "5", windowEnd: "2" }).problems).toContain("The window end must not come before its start.");
    expect(buildSpec("x", config, ["A"], { ...f, snapshotStep: "8" }).problems[0]).toContain("must come before step 8");
    expect(buildSpec("x", config, [], f).spec).toBeNull();
  });
});

describe("stale detection", () => {
  const base = buildSpec("test-256", config, ["A001", "A002"], defaultForm(config)).spec!;
  it("treats reordered agents as the same fork", () => {
    const again = buildSpec("test-256", config, ["A002", "A001"], defaultForm(config)).spec!;
    expect(canonicalSpec(again)).toBe(canonicalSpec(base));
  });
  it("matches the API's echo of a spec, which adds fields and floats", () => {
    const echoed = { ...base, interventions: [{ ...base.interventions[0], alpha: 300.0, positions: "all" as const }] };
    expect(canonicalSpec(echoed)).toBe(canonicalSpec(base));
  });
  it("notices each change to the form", () => {
    const f = defaultForm(config);
    for (const change of [{ alpha: "301" }, { replicates: "3" }, { sharedSeeds: false }, { batchInvariant: false }, { windowEnd: "6" }, { watchFeature: 2 }]) {
      const next = buildSpec("test-256", config, ["A001", "A002"], { ...f, ...change }).spec!;
      expect(canonicalSpec(next)).not.toBe(canonicalSpec(base));
    }
    expect(canonicalSpec(buildSpec("test-256", config, ["A001"], f).spec!)).not.toBe(canonicalSpec(base));
  });
  it("is not stale after a form is filled from a fork's own spec", () => {
    const form = formFromSpec(base, defaultForm(undefined));
    expect(canonicalSpec(buildSpec("test-256", config, ["A001", "A002"], form).spec!)).toBe(canonicalSpec(base));
  });
});
