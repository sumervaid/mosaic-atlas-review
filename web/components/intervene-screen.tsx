"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, post, progressSocketUrl, request, useFetch } from "@/lib/api";
import { fmtPercent, plural, prettyModel, visibleText } from "@/lib/format";
import { isTerminal, progressShare, progressText } from "@/lib/progress";
import { buildSpec, canonicalSpec, defaultForm, type FormState, formFromSpec, type Op } from "@/lib/spec";
import { type ColorBy, colorDomain, teamsOf, valuesAtStep } from "@/lib/swarm";
import type { Agent, AgentComparison, ExperimentDetail, ExperimentList, ForkProgress, ForkResults, Template } from "@/lib/types";
import { DivergenceFront, HopEffects, OutcomeTable, TraceChart } from "./charts";
import { Main, SelectorBar } from "./shell";
import { MapLegend, SwarmMap } from "./swarm-map";
import { BarLabel, Card, EmptyState, ErrorNote, Field, Loading, PageTitle, RecordedLabel, Seg, StepScrubber, TestModelBanner, Toggle } from "./ui";

const DEFAULT_EXPERIMENT = "pilot-negative-lead";
const TEST_CONCEPT_MODEL = "test-tiny-gemma3";
const TEST_CONCEPT_SOURCE = "sae-random-256";

function setUrl(params: Record<string, string | number | null | undefined>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  window.history.replaceState(null, "", url.toString());
}

/** Follow a fork over the WebSocket. If the socket fails, poll the status endpoint instead. */
function useForkProgress(forkId: string | null, onDone: (p: ForkProgress) => void) {
  const [progress, setProgress] = useState<ForkProgress | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!forkId) return;
    let closed = false;
    let finished = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    setProgress({ fork_id: forkId, status: "queued" });
    const update = (p: ForkProgress) => {
      if (closed || finished) return;
      setProgress(p);
      if (isTerminal(p)) {
        finished = true;
        if (poll) clearInterval(poll);
        done.current(p);
      }
    };
    const startPolling = () => {
      if (poll || finished || closed) return;
      poll = setInterval(() => {
        request<ForkProgress>(`/forks/${forkId}`).then(update).catch(() => undefined);
      }, 1000);
    };
    const ws = new WebSocket(progressSocketUrl(forkId));
    ws.onmessage = (e) => update(JSON.parse(e.data) as ForkProgress);
    ws.onerror = startPolling;
    ws.onclose = startPolling;
    return () => {
      closed = true;
      if (poll) clearInterval(poll);
      ws.onclose = null;
      ws.close();
    };
  }, [forkId]);
  return progress;
}

export function InterveneScreen() {
  const params = useSearchParams();
  // Kept while refreshing. Clearing them would blank the screen and restart the results fetch.
  const experiments = useFetch<ExperimentList>("/experiments", { keepPrevious: true });
  const templates = useFetch<Template[]>("/templates");

  const [expId, setExpId] = useState(params.get("exp") ?? DEFAULT_EXPERIMENT);
  const [forkId, setForkId] = useState<string | null>(params.get("fork"));
  const [activeFork, setActiveFork] = useState<string | null>(null);
  const [colorBy, setColorBy] = useState<ColorBy>((params.get("color") as ColorBy) ?? "difference");
  const [step, setStep] = useState<number | null>(params.get("step") ? Number(params.get("step")) : null);
  const [inspected, setInspected] = useState<string | null>(params.get("agent"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"select" | "inspect">("select");
  const [shownFeature, setShownFeature] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm(undefined));
  const [forkError, setForkError] = useState<ApiError | string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState("test_256");
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [playing, setPlaying] = useState(false);

  const recordedEntry = experiments.data?.recorded.find((e) => e.id === expId);
  const liveEntry = experiments.data?.live.find((e) => e.id === expId);
  const known = !!recordedEntry || !!liveEntry;
  const isRecorded = !!recordedEntry;

  const detailFetch = useFetch<ExperimentDetail>(known || !experiments.data ? `/experiments/${encodeURIComponent(expId)}` : null, { keepPrevious: true });
  const detail = { data: detailFetch.data?.id === expId ? detailFetch.data : null, reload: detailFetch.reload };
  const config = detail.data?.config;

  const effectiveFork = isRecorded ? expId : forkId;
  const resultsPath = useMemo(() => {
    if (!known || !effectiveFork || activeFork === effectiveFork) return null;
    const q = !isRecorded && shownFeature !== null ? `?feature=${shownFeature}` : "";
    return `/forks/${encodeURIComponent(effectiveFork)}/results${q}`;
  }, [known, effectiveFork, activeFork, isRecorded, shownFeature]);
  const results = useFetch<ForkResults>(resultsPath, { keepPrevious: true });
  const res = results.data && (results.data.fork_id === effectiveFork) ? results.data : null;

  const isTest = !isRecorded && (res?.is_test_model ?? config?.model.backend === "test");
  const agents: Agent[] = useMemo(() => (isRecorded ? (res?.agents ?? []) : (detail.data?.agents ?? [])), [isRecorded, res?.agents, detail.data?.agents]);

  // New experiment: new form, no selection, and the last fork the API lists.
  const formFor = useRef<string | null>(null);
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!detail.data || detail.data.id !== expId || formFor.current === expId) return;
    formFor.current = expId;
    setForm(defaultForm(detail.data.config));
    setForkId((cur) => {
      if (cur && detail.data?.forks.includes(cur)) return cur;
      autoPicked.current = true;
      return detail.data?.forks.at(-1) ?? null;
    });
  }, [detail.data, expId]);

  // A past fork fills the form, so its settings can be read and the results are not stale.
  const hydrated = useRef<string | null>(null);
  useEffect(() => {
    if (!res?.spec || hydrated.current === res.fork_id) return;
    hydrated.current = res.fork_id;
    const spec = res.spec;
    setForm((f) => formFromSpec(spec, f));
    setSelected(new Set(spec.interventions.flatMap((iv) => iv.agents)));
  }, [res]);

  // Keep the step on the axis of the current results.
  useEffect(() => {
    if (!res) return;
    setStep((s) => {
      if (s !== null && res.steps.includes(s)) return s;
      const withData = res.steps.filter((x) => Object.keys(res.map.treatment[String(x)] ?? {}).length);
      return withData.at(-1) ?? res.steps.at(-1) ?? null;
    });
    setInspected((a) => (a && res.agents.some((x) => x.id === a) ? a : (res.targets[0] ?? null)));
  }, [res]);

  useEffect(() => setUrl({ exp: expId, fork: isRecorded ? null : forkId, color: colorBy, step, agent: inspected }), [expId, forkId, colorBy, step, inspected, isRecorded]);

  useEffect(() => {
    if (!playing || !res) return;
    const id = setInterval(() => {
      setStep((s) => {
        const i = s === null ? -1 : res.steps.indexOf(s);
        return res.steps[(i + 1) % res.steps.length];
      });
    }, 800);
    return () => clearInterval(id);
  }, [playing, res]);

  const progress = useForkProgress(activeFork, (p) => {
    setActiveFork(null);
    detail.reload();
    experiments.reload();
    // Clearing the active fork opens the results path, which fetches them. A second fetch here would race it.
    if (p.status !== "complete") setFailure(progressText(p));
  });

  // Opening a fork that is still running, or one that failed, explains itself instead of showing a bare 404.
  useEffect(() => {
    if (isRecorded || !forkId || activeFork || results.error?.status !== 404) return;
    let live = true;
    request<ForkProgress>(`/forks/${encodeURIComponent(forkId)}`)
      .then((p) => {
        if (!live) return;
        if (p.status === "queued" || p.status === "running") {
          setActiveFork(forkId);
        } else if (autoPicked.current) {
          // Nobody chose this fork. Move to one that has results, if any does.
          const forks = detail.data?.forks ?? [];
          const earlier = forks[forks.indexOf(forkId) - 1];
          if (earlier) setForkId(earlier);
          else if (p.status === "failed") setFailure(progressText(p));
        } else if (p.status === "failed") {
          setFailure(progressText(p));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [results.error, forkId, activeFork, isRecorded, detail.data?.forks]);

  const chooseExperiment = (id: string) => {
    setExpId(id);
    setForkId(null);
    setActiveFork(null);
    setSelected(new Set());
    setShownFeature(null);
    setForkError(null);
    setFailure(null);
    setStep(null);
    setInspected(null);
    setPlaying(false);
    formFor.current = null;
    hydrated.current = null;
  };

  const createExperiment = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const rec = await post<{ id: string }>("/experiments", { template });
      experiments.reload();
      chooseExperiment(rec.id);
    } catch (err) {
      setCreateError(err as ApiError);
    } finally {
      setCreating(false);
    }
  };

  const selectedList = useMemo(() => [...selected], [selected]);
  const built = useMemo(() => (config ? buildSpec(expId, config, selectedList, form) : { spec: null, problems: [] }), [config, expId, selectedList, form]);
  const stale = !!(res?.spec && !activeFork && (!built.spec || canonicalSpec(built.spec) !== canonicalSpec(res.spec)));

  const startFork = async () => {
    if (!built.spec) return;
    setForkError(null);
    setFailure(null);
    try {
      const { fork_id } = await post<{ fork_id: string }>("/forks", built.spec);
      hydrated.current = fork_id;
      autoPicked.current = false;
      setActiveFork(fork_id);
      setForkId(fork_id);
      setShownFeature(null);
      setStep(null);
    } catch (err) {
      setForkError(err as ApiError);
    }
  };

  const onActivate = useCallback(
    (id: string) => {
      if (isRecorded || mode === "inspect") {
        setInspected(id);
        return;
      }
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [isRecorded, mode],
  );

  const values = useMemo(() => (res && step !== null ? valuesAtStep(res, colorBy, step) : {}), [res, step, colorBy]);
  const domain = useMemo(() => (res ? colorDomain(res, colorBy) : null), [res, colorBy]);
  const targetSet = useMemo(() => new Set(res?.targets ?? []), [res?.targets]);
  const roles = useMemo(() => [...new Set(agents.map((a) => a.role))], [agents]);
  const stepIndex = res && step !== null ? res.steps.indexOf(step) : -1;
  const shareNow = res && stepIndex >= 0 ? res.front.treatment[stepIndex] : undefined;
  const valueLabel = colorBy === "difference" ? "Treatment minus control" : colorBy === "control" ? "Control activation" : "Treatment activation";

  return (
    <>
      <SelectorBar>
        <BarLabel htmlFor="exp">Experiment</BarLabel>
        <select id="exp" className="field max-w-[330px]" value={expId} onChange={(e) => chooseExperiment(e.target.value)} data-testid="experiment-select">
          {!known && <option value={expId}>{expId}</option>}
          <optgroup label="Recorded comparisons">
            {experiments.data?.recorded.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </optgroup>
          <optgroup label="Live experiments">
            {experiments.data?.live.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}. {plural(e.agents, "agent")}
              </option>
            ))}
          </optgroup>
        </select>
        {!isRecorded && (detail.data?.forks.length ?? 0) > 0 && (
          <>
            <BarLabel htmlFor="forkpick">Fork</BarLabel>
            <select id="forkpick" className="field num" value={forkId ?? ""} onChange={(e) => { hydrated.current = null; autoPicked.current = false; setForkId(e.target.value); setFailure(null); setStep(null); }} data-testid="fork-select">
              {(forkId && !detail.data?.forks.includes(forkId) ? [forkId, ...(detail.data?.forks ?? [])] : (detail.data?.forks ?? [])).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        {!isRecorded && res && config && (
          <>
            <BarLabel htmlFor="shown">Read feature</BarLabel>
            <select id="shown" className="field num" value={shownFeature ?? res.concept.feature} onChange={(e) => setShownFeature(Number(e.target.value))}>
              {[...new Set([res.concept.feature, ...config.watch_features])].sort((a, b) => a - b).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="flex-1" />
        <label htmlFor="template" className="sr-only">
          Template for a new experiment
        </label>
        <select id="template" className="field max-w-[200px]" value={template} onChange={(e) => setTemplate(e.target.value)}>
          {(templates.data ?? [{ name: "test_256", id: "test-256", description: "", backend: "test", agents: 256, steps: 8 }]).map((t) => (
            <option key={t.name} value={t.name}>
              {t.id}. {t.backend === "test" ? "test model" : "needs a GPU"}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={createExperiment} disabled={creating} data-testid="new-experiment">
          {creating ? "Creating" : templates.data?.find((t) => t.name === template)?.backend === "hf" ? "New experiment" : "New test experiment"}
        </button>
      </SelectorBar>
      {isTest && <TestModelBanner />}
      <Main>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PageTitle title="Intervene and compare">
            Pick AI agents on the map. Change one activation inside them. MOSAIC forks the swarm into paired control and treatment branches, then shows how the change spreads.
          </PageTitle>
          {isRecorded && <RecordedLabel model={recordedEntry?.model} />}
        </div>
        {createError && <ErrorNote error={createError} />}
        {experiments.error && <ErrorNote error={experiments.error} />}
        {stale && (
          <div role="status" data-testid="stale-banner" className="rounded-lg bg-warn-bg px-3.5 py-2.5 text-[13px] text-warn-text">
            Settings changed since this fork. The results below reflect the fork&apos;s own settings until you fork again.
          </div>
        )}
        {experiments.data && !known && (
          <EmptyState>
            No experiment named {expId}. <button type="button" className="border-0 bg-transparent p-0 text-accent-text underline" onClick={() => chooseExperiment(DEFAULT_EXPERIMENT)}>Open the recorded pilot run.</button>
          </EmptyState>
        )}
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-[300px] flex-[1_1_320px] flex-col gap-4 lg:max-w-[360px]">
            {isRecorded ? (
              <RecordedPanel res={res} description={recordedEntry?.description} seeds={recordedEntry?.seeds ?? []} model={recordedEntry?.model} inspected={inspected} onInspect={setInspected} />
            ) : (
              detail.data && (
                <InterventionForm
                  agents={agents}
                  config={config}
                  edgesReady={!!config}
                  selected={selected}
                  setSelected={setSelected}
                  form={form}
                  setForm={setForm}
                  problems={built.problems}
                  canFork={!!built.spec && !activeFork}
                  running={!!activeFork}
                  progress={progress}
                  onFork={startFork}
                  forkError={forkError}
                  failure={failure}
                />
              )
            )}
          </div>
          <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
            <Card testid="map-card">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="cap m-0 font-normal">Swarm map</h2>
                <div className="flex flex-wrap items-center gap-3">
                  {!isRecorded && (
                    <Seg label="Click mode" value={mode} onChange={setMode} options={[{ value: "select", label: "Select agents" }, { value: "inspect", label: "Inspect agent" }]} />
                  )}
                  <Seg label="Colour by" value={colorBy} onChange={setColorBy} options={[{ value: "control", label: "Control" }, { value: "treatment", label: "Treatment" }, { value: "difference", label: "Difference" }]} />
                </div>
              </div>
              {agents.length > 0 ? (
                <SwarmMap
                  agents={agents}
                  edges={detail.data?.edges}
                  values={values}
                  domain={domain}
                  targets={targetSet}
                  selected={isRecorded ? undefined : selected}
                  inspected={inspected}
                  height={agents.length > 60 ? 620 : 440}
                  label={`Swarm map of ${expId}`}
                  valueLabel={valueLabel}
                  onActivate={onActivate}
                  actionHint={isRecorded || mode === "inspect" ? "Click an agent to read its messages." : "Click agents to select them for the fork."}
                  readoutExtra={(id) => (res?.hop[id] !== undefined ? `Hop ${res.hop[id]}.` : "")}
                />
              ) : (
                <Loading what="the agents" />
              )}
              {res && (
                <StepScrubber steps={res.steps} step={step} onChange={(s) => { setPlaying(false); setStep(s); }} playing={playing} onTogglePlay={() => setPlaying((p) => !p)} />
              )}
              <MapLegend
                domain={res ? domain : null}
                roles={roles}
                valueLabel={valueLabel}
                note={res ? `The colour range comes from agents that were not intervened on. Values beyond it take the end colour.${isRecorded && res.map_seed !== undefined ? ` This map shows seed ${res.map_seed}.` : ""}` : undefined}
              />
            </Card>

            {!isRecorded && activeFork && progress && (
              <EmptyState>Results appear here when the fork finishes. {progressText(progress)}</EmptyState>
            )}
            {!isRecorded && !activeFork && !forkId && detail.data && (
              <EmptyState testid="no-fork">No fork has run on this experiment yet. Select agents, set the change, then choose Fork and compare.</EmptyState>
            )}
            {!isRecorded && !activeFork && forkId && !res && results.error && !failure && (
              <EmptyState>
                {results.error.status === 404 ? "This fork has no results. It may not have finished." : results.error.message}{" "}
                <button type="button" className="border-0 bg-transparent p-0 text-accent-text underline" onClick={results.reload}>Try again.</button>
              </EmptyState>
            )}
            {isRecorded && results.error && (
              <EmptyState>
                {results.error.message}{" "}
                <button type="button" className="border-0 bg-transparent p-0 text-accent-text underline" onClick={results.reload}>Try again.</button>
              </EmptyState>
            )}
            {!res && results.loading && <Loading what="the results" />}
          </div>
        </div>
        {res && !activeFork && (
          <Results
            res={res}
            expId={expId}
            shareNow={shareNow}
            step={step}
            seeds={recordedEntry?.seeds}
            inspected={inspected}
            onInspect={setInspected}
            agents={agents}
          />
        )}
      </Main>
    </>
  );
}

function RecordedPanel({ res, description, seeds, model, inspected, onInspect }: { res: ForkResults | null; description?: string; seeds: number[]; model?: string; inspected: string | null; onInspect: (a: string) => void }) {
  const facts: [string, React.ReactNode][] = [];
  if (model) facts.push(["Model", prettyModel(model)]);
  if (res) {
    facts.push(["Activation read", <Link key="c" href={`/concept?model=gemma-3-4b-it&source=${encodeURIComponent(res.concept.source)}&index=${res.concept.feature}`}>{res.concept.label ?? `Feature ${res.concept.feature}`}</Link>]);
    facts.push(["AI agents", String(res.agents.length)]);
    facts.push(["Intervened", res.targets.join(", ")]);
    facts.push(["Paired seeds", seeds.join(", ") || String(res.replicates)]);
    facts.push(["Steps", `${res.steps[0]} to ${res.steps.at(-1)}`]);
  }
  return (
    <>
      <Card title="Recorded run" testid="recorded-panel">
        {description && <p className="m-0 text-[15px] leading-snug font-medium">{description}</p>}
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-3">{k}</dt>
              <dd className="m-0 min-w-0 text-right break-words text-text">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Fork">
        <p className="m-0 text-[13px] leading-relaxed text-text-2">Forking needs a live backend. This run is read only and holds no model weights.</p>
        <p className="note m-0">To fork, choose a live experiment or create a test experiment in the bar above.</p>
      </Card>
      {res && (
        <Card title="Inspect an agent">
          <Field label="Agent" hint="Or click an agent on the map.">
            {(id) => (
              <select id={id} className="field w-full" value={inspected ?? ""} onChange={(e) => onInspect(e.target.value)}>
                {res.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}. {a.role}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </Card>
      )}
    </>
  );
}

interface FormProps {
  agents: Agent[];
  config: ExperimentDetail["config"];
  edgesReady: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  problems: string[];
  canFork: boolean;
  running: boolean;
  progress: ForkProgress | null;
  onFork: () => void;
  forkError: ApiError | string | null;
  failure: string | null;
}

function InterventionForm({ agents, config, selected, setSelected, form, setForm, problems, canFork, running, progress, onFork, forkError, failure }: FormProps) {
  const teams = teamsOf(agents);
  const [team, setTeam] = useState<number | null>(null);
  const activeTeam = team ?? teams[0] ?? null;
  const watch = config?.watch_features ?? [];
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const chips = [...selected].slice(0, 12);
  return (
    <>
      <Card title="1. Agents" aside={`${selected.size} selected`} testid="agents-card">
        <div className="flex min-h-7 flex-wrap gap-1.5">
          {chips.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={`Remove ${id} from the selection`}
              className="num inline-flex h-7 items-center gap-1 rounded-full border border-warn-border bg-warn-bg px-2 text-[11px] text-warn-text"
              onClick={() => {
                const next = new Set(selected);
                next.delete(id);
                setSelected(next);
              }}
            >
              {id} <span aria-hidden="true">×</span>
            </button>
          ))}
          {selected.size > chips.length && <span className="num self-center text-[11px] text-text-3">{selected.size - chips.length} more</span>}
          {selected.size === 0 && <span className="lbl self-center">Click agents on the map, or use a shortcut.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor="team-pick" className="sr-only">Team</label>
          <select id="team-pick" className="field w-[92px]" value={activeTeam ?? ""} onChange={(e) => setTeam(Number(e.target.value))} disabled={!teams.length}>
            {teams.map((t) => (
              <option key={t} value={t}>
                Team {t}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={activeTeam === null} onClick={() => setSelected(new Set(agents.filter((a) => a.team === activeTeam).map((a) => a.id)))}>
            Select team
          </button>
          <button type="button" className="btn" onClick={() => setSelected(new Set(agents.filter((a) => a.role === "Lead").map((a) => a.id)))}>
            All leads
          </button>
          <button type="button" className="btn" disabled={!agents.some((a) => a.role === "Coordinator")} onClick={() => setSelected(new Set(agents.filter((a) => a.role === "Coordinator").map((a) => a.id)))}>
            Coordinator
          </button>
          <button type="button" className="btn" disabled={!selected.size} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      </Card>

      <Card title="2. Activation change" testid="change-card">
        <Seg<Op> label="Operation" value={form.op} onChange={(v) => set("op", v)} options={[{ value: "clamp", label: "Clamp" }, { value: "ablate", label: "Ablate" }, { value: "add", label: "Add vector" }]} />
        {form.op !== "add" && (
          <Field label="Feature index" hint={form.op === "ablate" ? "Sets this feature to zero where it is active." : undefined}>
            {(id) => (
              <select id={id} className="field num w-full" value={form.feature} onChange={(e) => set("feature", Number(e.target.value))}>
                {watch.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          {form.op === "clamp" && (
            <Field label="Value">{(id) => <input id={id} className="field num w-full" inputMode="decimal" value={form.value} onChange={(e) => set("value", e.target.value)} />}</Field>
          )}
          {form.op === "add" && (
            <>
              <Field label="Vector id">{(id) => <input id={id} className="field num w-full" value={form.vectorId} onChange={(e) => set("vectorId", e.target.value)} data-testid="vector-id" />}</Field>
              <Field label="Alpha">{(id) => <input id={id} className="field num w-full" inputMode="decimal" value={form.alpha} onChange={(e) => set("alpha", e.target.value)} data-testid="alpha" />}</Field>
            </>
          )}
          <Field label="Window start">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={form.windowStart} onChange={(e) => set("windowStart", e.target.value)} />}</Field>
          <Field label="Window end">{(id) => <input id={id} className="field num w-full" inputMode="numeric" placeholder="to the end" value={form.windowEnd} onChange={(e) => set("windowEnd", e.target.value)} />}</Field>
        </div>
        <p className="num m-0 text-[11px] text-text-4">Layer {config?.layer}, from this experiment&apos;s config.</p>
      </Card>

      <Card title="3. Controls" testid="controls-card">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Replicates">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={form.replicates} onChange={(e) => set("replicates", e.target.value)} data-testid="replicates" />}</Field>
          <Field label="Fork at step">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={form.snapshotStep} onChange={(e) => set("snapshotStep", e.target.value)} data-testid="snapshot-step" />}</Field>
          <Field label="Watch feature">
            {(id) => (
              <select id={id} className="field num w-full" value={form.watchFeature ?? ""} onChange={(e) => set("watchFeature", Number(e.target.value))} data-testid="watch-feature">
                {watch.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="flex flex-col">
          <Toggle label="Shared random seeds per pair" checked={form.sharedSeeds} onChange={(v) => set("sharedSeeds", v)} />
          <Toggle label="Batch-invariant decoding" checked={form.batchInvariant} onChange={(v) => set("batchInvariant", v)} />
        </div>
      </Card>

      <button type="button" className="btn btn-primary" disabled={!canFork} onClick={onFork} data-testid="fork-button">
        {running ? "Fork running" : "Fork and compare"}
      </button>
      {!running && problems.length > 0 && (
        <ul className="note m-0 list-none p-0" data-testid="form-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {progress && (running || progress.status === "complete") && (
        <div className="flex flex-col gap-1.5" data-testid="fork-progress" data-status={progress.status}>
          <div className="h-1.5 overflow-hidden rounded bg-border" role="progressbar" aria-label="Fork progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressShare(progress) * 100)}>
            <div className="h-1.5 bg-accent transition-[width]" style={{ width: `${progressShare(progress) * 100}%` }} />
          </div>
          <span className="num text-[12px] text-text-3" aria-live="polite">{progressText(progress)}</span>
        </div>
      )}
      <ErrorNote error={forkError} />
      <ErrorNote error={failure} />
    </>
  );
}

function LogVerification({ log }: { log: ForkResults["log_verification"] }) {
  if (!log) return <span className="text-[13px] text-text-3">The log has not been checked for this fork.</span>;
  const method = log.kind ? `${log.kind} check` : "signed log check";
  return log.all_ok ? (
    <span className="text-[13px] text-ok-text" data-testid="log-verification">
      Log verified. All {plural(log.branches_checked, "branch", "branches")} pass the {method}.
    </span>
  ) : (
    <span className="text-[13px] font-medium text-warn-text" data-testid="log-verification">
      Log check failed. At least one of {plural(log.branches_checked, "branch", "branches")} does not pass the {method}. Do not rely on these results.
    </span>
  );
}

function Results({ res, expId, shareNow, step, seeds, inspected, onInspect, agents }: { res: ForkResults; expId: string; shareNow?: number; step: number | null; seeds?: number[]; inspected: string | null; onInspect: (a: string) => void; agents: Agent[] }) {
  const conceptName = res.concept.label ?? `feature ${res.concept.feature}`;
  return (
    <div className="flex flex-col gap-4" data-testid="results">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <LogVerification log={res.log_verification} />
        <span className="num text-[12px] text-text-3">
          {res.recorded ? `${plural(res.replicates, "seed")}` : `${plural(res.replicates, "replicate pair")}`}. Reads {conceptName}.
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        <Card title="Divergence front" aside={shareNow !== undefined && step !== null ? `${fmtPercent(shareNow)} at step ${step}` : undefined} className="min-w-[280px] flex-[1_1_320px]" testid="front-card">
          <DivergenceFront res={res} />
          <p className="note m-0">
            Blue shows the share of AI agents whose messages differ from the paired control.{" "}
            {res.front.noise_floor_measured && res.front.noise_floor ? "Grey shows control against control, the noise floor." : "Noise floor not measured for this run, so no grey bars appear."}
          </p>
        </Card>
        <Card title="Effect by hop" aside="Change in activation" className="min-w-[320px] flex-[2_1_560px]" testid="hop-card">
          {res.hop_effects.length ? <HopEffects res={res} /> : <EmptyState>The fork recorded no readings for this feature.</EmptyState>}
          <p className="note m-0">Treatment minus control, in activation units. Hops count message ties from the nearest intervened agent. Each panel has its own vertical scale. Dashed lines mark the overall effect, printed below with its 95% interval. Whiskers show 95% intervals by step.</p>
        </Card>
      </div>
      <Card title="Swarm outcomes" aside="Treatment minus control" testid="outcomes-card">
        <OutcomeTable outcomes={res.outcomes} />
        <p className="note m-0">Colour and a filled dot mean the 95% interval excludes zero.</p>
      </Card>
      <AgentPanel key={res.fork_id} res={res} expId={expId} seeds={seeds} agent={inspected} onAgent={onInspect} agents={agents} />
    </div>
  );
}

function AgentPanel({ res, expId, seeds, agent, onAgent, agents }: { res: ForkResults; expId: string; seeds?: number[]; agent: string | null; onAgent: (a: string) => void; agents: Agent[] }) {
  const replicateOptions = res.recorded ? (seeds ?? []) : Array.from({ length: res.replicates }, (_, i) => i);
  const [replicate, setReplicate] = useState<number>(res.recorded ? (res.map_seed ?? replicateOptions[0] ?? 0) : 0);
  const [msgStep, setMsgStep] = useState<number | null>(null);
  const path = agent ? `/forks/${encodeURIComponent(res.fork_id)}/agents/${encodeURIComponent(agent)}?replicate=${replicate}${res.recorded ? "" : `&feature=${res.concept.feature}`}` : null;
  const cmp = useFetch<AgentComparison>(path);
  const data = cmp.data && cmp.data.agent === agent ? cmp.data : null;
  const steps = useMemo(() => [...new Set([...(data?.control ?? []), ...(data?.treatment ?? [])].map((m) => m.step))].sort((a, b) => a - b), [data]);

  useEffect(() => {
    setMsgStep(data ? (data.first_divergence ?? data.treatment[0]?.step ?? data.control[0]?.step ?? null) : null);
  }, [data]);

  const left = data?.control.find((m) => m.step === msgStep);
  const right = data?.treatment.find((m) => m.step === msgStep);
  const conceptHref = res.recorded
    ? `/concept?model=gemma-3-4b-it&source=${encodeURIComponent(res.concept.source)}&index=${res.concept.feature}`
    : res.is_test_model
      ? `/concept?model=${TEST_CONCEPT_MODEL}&source=${TEST_CONCEPT_SOURCE}&index=${res.concept.feature}`
      : null;
  return (
    <Card title={`Agent comparison${agent ? `. ${agent}` : ""}`} testid="agent-card">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Agent">
          {(id) => (
            <select id={id} className="field w-44" value={agent ?? ""} onChange={(e) => onAgent(e.target.value)} data-testid="agent-select">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}. {a.role}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={res.recorded ? "Seed" : "Replicate"}>
          {(id) => (
            <select id={id} className="field num w-20" value={replicate} onChange={(e) => setReplicate(Number(e.target.value))} data-testid="replicate-select">
              {replicateOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </Field>
        <span className="flex-1" />
        <Link className="btn" href={`/contagion?exp=${encodeURIComponent(expId)}`}>Open in the contagion tracer</Link>
        {conceptHref && <Link className="btn" href={conceptHref}>Open concept</Link>}
      </div>
      {cmp.error && <ErrorNote error={cmp.error} />}
      {!agent && <EmptyState>Inspect an agent on the map to read its paired messages.</EmptyState>}
      {cmp.loading && !data && <Loading what="the messages" />}
      {data && steps.length === 0 && (
        <EmptyState testid="agent-empty">
          {res.recorded
            ? `${data.agent} has no messages in seed ${replicate}. Each recorded seed draws its own named agents, and the API lists the roster of seed ${res.map_seed ?? replicateOptions[0]} only.`
            : `${data.agent} sent no messages in replicate ${replicate}.`}
        </EmptyState>
      )}
      {data && steps.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Step of the message pair">
            <span className="lbl mr-1">Step</span>
            {steps.map((s) => {
              const on = s === msgStep;
              const first = s === data.first_divergence;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  aria-label={first ? `Step ${s}, first divergence` : `Step ${s}`}
                  onClick={() => setMsgStep(s)}
                  className={`num h-7 min-w-7 rounded-md border px-1.5 text-[12px] ${on ? "border-text bg-text text-bg" : first ? "border-warn text-warn-text" : "border-border-input text-text-2 hover:bg-chip"}`}
                >
                  {s}
                </button>
              );
            })}
            <span className="note ml-2" data-testid="first-divergence">
              {data.first_divergence === null ? "This agent's messages never differ between branches." : `Messages first differ at step ${data.first_divergence}.`}
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2" data-testid="paired-messages">
            <MessageBox title={`Control. Step ${msgStep}`} text={left?.text} tone="control" />
            <MessageBox title={`Treatment. Step ${msgStep}`} text={right?.text} tone="treatment" firstDivergence={msgStep === data.first_divergence} />
          </div>
          {data.trace.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="lbl">Activation of {res.concept.label ?? `feature ${res.concept.feature}`} by step</span>
              <TraceChart trace={data.trace} firstDivergence={data.first_divergence} marker={msgStep} />
            </div>
          ) : (
            <EmptyState>No activation readings exist for this agent and feature.</EmptyState>
          )}
        </>
      )}
    </Card>
  );
}

export function MessageBox({ title, text, tone, firstDivergence }: { title: string; text?: string; tone: "control" | "treatment"; firstDivergence?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 rounded-lg p-3 ${tone === "treatment" ? "bg-accent-bg" : "bg-bg"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[12px] ${tone === "treatment" ? "text-accent-text" : "text-text-3"}`}>{title}</span>
        {firstDivergence && <span className="rounded border border-warn-border bg-warn-bg px-1.5 py-px text-[11px] text-warn-text">First divergence</span>}
      </div>
      {text !== undefined ? (
        <p className="message m-0 text-[14px] leading-normal text-text">{visibleText(text)}</p>
      ) : (
        <p className="m-0 text-[13px] text-text-3">No message at this step.</p>
      )}
    </div>
  );
}
