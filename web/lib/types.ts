// Response shapes of the MOSAIC Atlas API. See mosaic/api/app.py.

export interface Agent {
  id: string;
  role: string;
  team: number;
  model?: string;
  persona?: string;
}

export interface RecordedExperiment {
  id: string;
  recorded: true;
  description: string;
  model: string;
  fork_id: string;
  seeds: number[];
}

export interface LiveExperiment {
  id: string;
  created: number;
  git_sha: string | null;
  description: string;
  model: string;
  backend: string;
  agents: number;
  steps: number;
  snapshots: number[];
  forks: string[];
}

export interface ExperimentList {
  recorded: RecordedExperiment[];
  live: LiveExperiment[];
}

export interface ExperimentConfig {
  id: string;
  description: string;
  model: { backend: string; model_id: string };
  steps: number;
  layer: number;
  watch_features: number[];
}

export interface ExperimentDetail {
  id: string;
  recorded?: boolean;
  description?: string;
  config?: ExperimentConfig;
  agents: Agent[];
  edges: Record<string, string[]>;
  snapshots: number[];
  forks: string[];
}

export interface Template {
  name: string;
  id: string;
  description: string;
  backend: string;
  agents: number;
  steps: number;
}

export interface Intervention {
  agents: string[];
  layer: number;
  op: "clamp" | "ablate" | "add";
  feature: number | null;
  value: number | null;
  vector_id: string | null;
  alpha: number | null;
  window: [number, number | null];
  positions?: "all" | "generated";
}

export interface ForkSpec {
  experiment_id: string;
  snapshot_step: number;
  replicates: number;
  interventions: Intervention[];
  shared_seeds: boolean;
  batch_invariant: boolean;
  watch_feature: number | null;
}

export interface ForkProgress {
  fork_id: string;
  status: "queued" | "running" | "complete" | "failed" | "unknown";
  branch?: string | null;
  branch_step?: number | null;
  steps?: number | null;
  branches_done?: number | null;
  branches_total?: number | null;
  error?: string | null;
}

export interface Estimate {
  estimate: number;
  ci: [number, number] | null;
  n: number;
}

export interface HopEffect {
  hop: string;
  agents: number;
  overall: Estimate | null;
  by_step: Record<string, Estimate>;
}

export interface Outcome {
  name: string;
  label: string;
  control: number | null;
  treatment: number | null;
  difference: Estimate | null;
  excludes_zero: boolean;
  not_measured?: string;
}

export type StepMap = Record<string, Record<string, number>>;

export interface ForkResults {
  fork_id: string;
  experiment_id?: string;
  status: string;
  recorded: boolean;
  is_test_model?: boolean;
  description?: string;
  model: string;
  replicates: number;
  steps: number[];
  agents: Agent[];
  targets: string[];
  hop: Record<string, string>;
  concept: { source: string; feature: number; label?: string };
  front: { treatment: number[]; noise_floor: number[] | null; noise_floor_measured: boolean };
  divergence?: Record<string, { median: number; iqr: [number, number]; diverged_in: number; replicates: number }>;
  hop_effects: HopEffect[];
  outcomes: Outcome[];
  map: { control: StepMap; treatment: StepMap };
  log_verification: { branches_checked: number; all_ok: boolean; kind?: string } | null;
  map_seed?: number;
  spec?: ForkSpec;
}

export interface PairedMessage {
  step: number;
  text: string;
  id: string;
}

export interface TracePoint {
  step: number;
  control: number | null;
  treatment: number | null;
}

export interface AgentComparison {
  agent: string;
  replicate: number;
  first_divergence: number | null;
  control: PairedMessage[];
  treatment: PairedMessage[];
  trace: TracePoint[];
  description?: string;
}

export interface ModelSource {
  id: string;
  kind: string;
  layer: number;
  n_features: number;
  note?: string;
}

export interface ModelEntry {
  id: string;
  name?: string;
  kind: "test" | "recorded" | "huggingface";
  available: boolean;
  live: boolean;
  note: string;
  repo?: string;
  profile?: string;
  sources: ModelSource[];
}

export interface TopActivation {
  activation: number;
  text: string;
  agent: string;
  step: number;
  config: string;
  seed?: number;
}

export interface ConceptPage {
  model: string;
  source: string;
  index: number;
  label: string | null;
  layer: number;
  n_features: number;
  live: boolean;
  is_test_model?: boolean;
  explanations: { text: string; method: string; score: number | null }[];
  explanations_note?: string;
  neighbours: { index: number; cosine: number }[] | null;
  neighbours_note?: string;
  logits: { positive: { token: string; value: number }[]; negative: { token: string; value: number }[] } | null;
  logits_note?: string;
  density: { n: number; counts: number[]; edges: number[] } | null;
  density_note?: string;
  top_activations: TopActivation[];
  dropped_dimensions?: number[];
}

export interface ConceptSwarm {
  step: number | null;
  agents: Record<string, number>;
  role_means: Record<string, number>;
  per_step_mean: Record<string, number>;
  empty?: string;
}

export interface TokenActivations {
  tokens: string[];
  activations: number[];
}

export interface ExplanationResult {
  model: string;
  source: string;
  index: number;
  label: string;
  explanation: string;
}

export interface InferenceResult {
  feature: number;
  max_act: number;
  token_index: number;
  token: string;
  source: string;
}

export interface SearchResponse<R> {
  mode: string;
  model?: string;
  is_test_model?: boolean;
  tokens?: string[];
  results: R[];
  note?: string;
}

export interface SteerResponse {
  default: string;
  steered: string;
  model: string;
  is_test_model: boolean;
  seed: number;
  identical: boolean;
}

export interface ContagionNode {
  id: string;
  agent: string;
  step: number;
  text: string;
  recipients?: string[];
}

export interface ContagionEdge {
  message_id: string;
  from: string;
  to: string;
  step: number;
  feature: number;
  weight: number;
  replicates: number;
  recipient_silent_without_message: number;
  method: string;
}

export interface ContagionGraph {
  recorded: boolean;
  is_test_model?: boolean;
  fork_id?: string;
  seed?: number;
  agents: Agent[];
  nodes: ContagionNode[];
  edges: ContagionEdge[];
  empty: string | null;
}

export interface ComputeProfile {
  machine: string;
  gpus: number;
  config: string;
  label: string;
}

export interface ComputeStatus {
  settings: {
    key_path: string;
    project: string;
    zone: string;
    instance: string;
    profile: string;
    hf_token_path: string;
  };
  key: { path: string; client_email: string; project_id: string; group_or_world_readable: boolean } | null;
  key_error: string | null;
  profiles: Record<string, ComputeProfile>;
  problems: string[];
  gpu_here: boolean;
  loaded_models: string[];
}

export interface GcpRunResult {
  dry_run: boolean;
  commands?: string[];
  tunnel?: string;
  ok?: boolean;
  steps?: { command: string; returncode: number; stderr: string }[];
}

export interface Health {
  ok: boolean;
  gpu: boolean;
  gpu_count: number;
  loaded_models: string[];
}
