// Turns the Intervene form into a ForkSpec and checks it before it reaches the API.
import type { ExperimentConfig, ForkSpec } from "./types";

export type Op = "clamp" | "ablate" | "add";

export interface FormState {
  op: Op;
  feature: number;
  vectorId: string;
  value: string;
  alpha: string;
  windowStart: string;
  windowEnd: string;
  replicates: string;
  snapshotStep: string;
  watchFeature: number | null;
  sharedSeeds: boolean;
  batchInvariant: boolean;
}

/** On the test model, a useful default. A steering vector with a large coefficient reaches other agents in a short run. */
export function defaultForm(config: ExperimentConfig | undefined): FormState {
  const watch = config?.watch_features ?? [];
  const isTest = config?.model.backend === "test";
  return {
    op: isTest ? "add" : "clamp",
    feature: watch[0] ?? 0,
    vectorId: "test-vector",
    value: "1",
    alpha: "300",
    windowStart: isTest ? "1" : "0",
    windowEnd: "",
    replicates: isTest ? "2" : "20",
    snapshotStep: isTest ? "1" : "0",
    watchFeature: watch.includes(3) ? 3 : (watch[0] ?? null),
    sharedSeeds: true,
    batchInvariant: true,
  };
}

function int(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

function num(text: string): number | null {
  const t = text.trim();
  if (t === "" || !Number.isFinite(Number(t))) return null;
  return Number(t);
}

export interface BuiltSpec {
  spec: ForkSpec | null;
  problems: string[];
}

export function buildSpec(experimentId: string, config: ExperimentConfig, agents: string[], form: FormState): BuiltSpec {
  const problems: string[] = [];
  if (!agents.length) problems.push("Select at least one agent.");
  const value = num(form.value);
  const alpha = num(form.alpha);
  if (form.op === "clamp" && value === null) problems.push("Clamp needs a target value.");
  if (form.op === "add" && alpha === null) problems.push("Add needs a coefficient.");
  if (form.op === "add" && !form.vectorId.trim()) problems.push("Add needs a vector id.");
  const start = int(form.windowStart);
  const end = form.windowEnd.trim() === "" ? null : int(form.windowEnd);
  if (start === null || start < 0) problems.push("The window start must be a whole number, zero or above.");
  if (form.windowEnd.trim() !== "" && end === null) problems.push("The window end must be a whole number, or blank.");
  if (start !== null && end !== null && end < start) problems.push("The window end must not come before its start.");
  const replicates = int(form.replicates);
  if (replicates === null || replicates < 1) problems.push("Replicates must be at least 1.");
  const snapshot = int(form.snapshotStep);
  if (snapshot === null || snapshot < 0) problems.push("The fork step must be a whole number, zero or above.");
  if (snapshot !== null && snapshot >= config.steps) problems.push(`The fork step must come before step ${config.steps}, the end of this experiment.`);
  if (problems.length) return { spec: null, problems };
  return {
    spec: {
      experiment_id: experimentId,
      snapshot_step: snapshot as number,
      replicates: replicates as number,
      shared_seeds: form.sharedSeeds,
      batch_invariant: form.batchInvariant,
      watch_feature: form.watchFeature,
      interventions: [
        {
          agents,
          layer: config.layer,
          op: form.op,
          feature: form.op === "add" ? null : form.feature,
          value: form.op === "clamp" ? value : null,
          vector_id: form.op === "add" ? form.vectorId.trim() : null,
          alpha: form.op === "add" ? alpha : null,
          window: [start as number, end],
        },
      ],
    },
    problems: [],
  };
}

/** A stable text form of a spec. Two specs mean the same fork when these match. */
export function canonicalSpec(spec: ForkSpec): string {
  return JSON.stringify({
    e: spec.experiment_id,
    s: spec.snapshot_step,
    r: spec.replicates,
    c: spec.shared_seeds,
    b: spec.batch_invariant,
    w: spec.watch_feature ?? null,
    i: spec.interventions.map((iv) => ({
      a: [...iv.agents].sort(),
      l: iv.layer,
      o: iv.op,
      f: iv.feature ?? null,
      v: iv.value ?? null,
      x: iv.vector_id ?? null,
      y: iv.alpha ?? null,
      n: [iv.window[0], iv.window[1] ?? null],
    })),
  });
}

/** Fill the form from a past fork, so its settings can be read and adjusted. */
export function formFromSpec(spec: ForkSpec, fallback: FormState): FormState {
  const iv = spec.interventions[0];
  if (!iv) return fallback;
  return {
    ...fallback,
    op: iv.op,
    feature: iv.feature ?? fallback.feature,
    vectorId: iv.vector_id ?? fallback.vectorId,
    value: iv.value === null || iv.value === undefined ? fallback.value : String(iv.value),
    alpha: iv.alpha === null || iv.alpha === undefined ? fallback.alpha : String(iv.alpha),
    windowStart: String(iv.window[0]),
    windowEnd: iv.window[1] === null || iv.window[1] === undefined ? "" : String(iv.window[1]),
    replicates: String(spec.replicates),
    snapshotStep: String(spec.snapshot_step),
    watchFeature: spec.watch_feature ?? fallback.watchFeature,
    sharedSeeds: spec.shared_seeds,
    batchInvariant: spec.batch_invariant,
  };
}
