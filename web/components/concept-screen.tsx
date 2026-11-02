"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type ApiError, conceptPath, post, useFetch } from "@/lib/api";
import { activationColor } from "@/lib/color";
import { uniqueRows } from "@/lib/contagion";
import { fmt, plural, prettyModel, visibleText, visibleToken } from "@/lib/format";
import type { ColorDomain } from "@/lib/swarm";
import type { ConceptPage, ConceptSwarm, ExperimentDetail, ExperimentList, ModelEntry, TokenActivations } from "@/lib/types";
import { DensityChart, PerStepMean } from "./charts";
import { Main, SelectorBar } from "./shell";
import { MapLegend, SwarmMap } from "./swarm-map";
import { BarLabel, Card, EmptyState, ErrorNote, Loading, RecordedLabel, StepScrubber, TestModelBanner } from "./ui";

const DEFAULTS = { model: "gemma-3-4b-it", source: "pilot-directions", index: 0 };

/** The model id the concept routes expect, for a row of GET /models. */
const routeModel = (m: ModelEntry) => m.name ?? m.id;

export function ConceptScreen() {
  const params = useSearchParams();
  const models = useFetch<ModelEntry[]>("/models");
  const [model, setModel] = useState(params.get("model") ?? DEFAULTS.model);
  const [source, setSource] = useState(params.get("source") ?? DEFAULTS.source);
  const [index, setIndex] = useState(Number(params.get("index") ?? DEFAULTS.index));
  const [draftIndex, setDraftIndex] = useState(String(params.get("index") ?? DEFAULTS.index));

  // A link to another concept changes the URL. Follow it.
  useEffect(() => {
    setModel(params.get("model") ?? DEFAULTS.model);
    setSource(params.get("source") ?? DEFAULTS.source);
    setIndex(Number(params.get("index") ?? DEFAULTS.index));
  }, [params]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("model", model);
    url.searchParams.set("source", source);
    url.searchParams.set("index", String(index));
    window.history.replaceState(null, "", url.toString());
    setDraftIndex(String(index));
  }, [model, source, index]);

  const entries = models.data ?? [];
  const entry = entries.find((m) => routeModel(m) === model && m.sources.some((s) => s.id === source)) ?? entries.find((m) => routeModel(m) === model);
  const sourceInfo = entry?.sources.find((s) => s.id === source);
  const page = useFetch<ConceptPage>(conceptPath(model, source, index));
  const concept = page.data;
  const limit = concept?.n_features ?? sourceInfo?.n_features ?? 1;
  const isVector = source === "vector";
  const count = isVector ? 1 : limit;

  const chooseModel = (id: string) => {
    const m = entries.find((x) => x.id === id);
    if (!m) return;
    setModel(routeModel(m));
    setSource(m.sources[0]?.id ?? "");
    setIndex(0);
  };

  return (
    <>
      <SelectorBar>
        <BarLabel htmlFor="c-model">Model</BarLabel>
        <select id="c-model" className="field" value={entry?.id ?? ""} onChange={(e) => chooseModel(e.target.value)} data-testid="concept-model">
          {!entry && <option value="">{model}</option>}
          {entries.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {routeModel(m)}. {m.kind === "recorded" ? "recorded" : m.kind === "test" ? "test model" : m.available ? "loaded" : "not loaded"}
            </option>
          ))}
        </select>
        <BarLabel htmlFor="c-source">Source</BarLabel>
        <select id="c-source" className="field num max-w-[300px]" value={source} onChange={(e) => { setSource(e.target.value); setIndex(0); }}>
          {!sourceInfo && <option value={source}>{source}</option>}
          {entry?.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
        <BarLabel htmlFor="c-index">Index</BarLabel>
        <input
          id="c-index"
          className="field num w-20"
          inputMode="numeric"
          value={draftIndex}
          onChange={(e) => setDraftIndex(e.target.value)}
          onBlur={() => { const n = Number(draftIndex); if (Number.isInteger(n) && n >= 0 && n < count) setIndex(n); else setDraftIndex(String(index)); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <button type="button" className="btn" disabled={index <= 0} onClick={() => setIndex(index - 1)}>
          Prev
        </button>
        <button type="button" className="btn" disabled={index >= count - 1} onClick={() => setIndex(index + 1)}>
          Next
        </button>
        <span className="num text-[12px] text-text-3">{plural(count, "feature")} in this source</span>
        <span className="flex-1" />
        {concept && !concept.live && <RecordedLabel model={concept.model} />}
      </SelectorBar>
      {concept?.is_test_model && <TestModelBanner />}
      <Main>
        {page.loading && !concept && <Loading what="this concept" />}
        {page.error && (
          <EmptyState testid="concept-error">
            {page.error.message}
            {page.error.status === 409 && (
              <>
                {" "}
                <Link href="/setup">Open Setup.</Link>
              </>
            )}
          </EmptyState>
        )}
        {concept && <ConceptBody concept={concept} />}
      </Main>
    </>
  );
}

function ConceptBody({ concept }: { concept: ConceptPage }) {
  const rows = useMemo(() => uniqueRows(concept.top_activations), [concept.top_activations]);
  const [showAll, setShowAll] = useState(false);
  const shownRows = showAll ? rows : rows.slice(0, 6);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-[300px] flex-[1_1_340px] flex-col gap-4 lg:max-w-[420px]">
        <section className="card flex flex-col gap-3 p-4" data-testid="explanations">
          <span className="num text-[11px] break-all text-text-3">
            {concept.model} / {concept.source} / {concept.index}
          </span>
          <h1 className="m-0 text-[24px] leading-tight font-semibold tracking-[-0.01em]">{concept.label ?? `Feature ${concept.index}`}</h1>
          <span className="num text-[12px] text-text-3">
            Layer {concept.layer}. {prettyModel(concept.model)}.
            {concept.dropped_dimensions?.length ? ` ${plural(concept.dropped_dimensions.length, "dropped dimension")}: ${concept.dropped_dimensions.join(", ")}.` : ""}
          </span>
          <h2 className="cap m-0 border-t border-divider pt-3 font-normal">Explanations</h2>
          {concept.explanations.length === 0 && <EmptyState>{concept.explanations_note ?? "No explanation exists for this feature."}</EmptyState>}
          {concept.explanations.map((x) => (
            <div key={x.text} className="flex flex-col gap-1.5">
              <span className="text-[14px] leading-snug">{x.text}</span>
              <span className="flex items-center gap-2">
                <span className="chip">{x.method}</span>
                <span className="num text-[11px] text-text-3">{x.score === null ? "No score" : `Score ${fmt(x.score)}`}</span>
              </span>
            </div>
          ))}
        </section>

        <Card title="Top features by cosine similarity" testid="neighbours">
          {concept.neighbours ? (
            concept.neighbours.length ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {concept.neighbours.map((n) => (
                  <li key={n.index} className="flex items-center justify-between border-t border-divider py-1.5 first:border-t-0">
                    <Link className="num text-[13px]" href={`/concept?model=${encodeURIComponent(concept.model)}&source=${encodeURIComponent(concept.source)}&index=${n.index}`}>
                      Feature {n.index}
                    </Link>
                    <span className="num text-[12px] text-text-2">{fmt(n.cosine)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>This feature has no neighbours.</EmptyState>
            )
          ) : (
            <EmptyState>{concept.neighbours_note ?? "No neighbours exist for this source."}</EmptyState>
          )}
        </Card>

        <Card title="Logits" testid="logits">
          {concept.logits ? (
            <div className="grid grid-cols-2 gap-3.5">
              <LogitList title="Negative" rows={concept.logits.negative} tone="neg" />
              <LogitList title="Positive" rows={concept.logits.positive} tone="pos" />
            </div>
          ) : (
            <EmptyState>{concept.logits_note ?? "Logits need a loaded model."}</EmptyState>
          )}
        </Card>

        <Card title="Activation density" aside={concept.density ? `n = ${concept.density.n.toLocaleString("en-US")}` : undefined} testid="density">
          {concept.density ? <DensityChart counts={concept.density.counts} edges={concept.density.edges} /> : <EmptyState>{concept.density_note ?? "No density exists for this feature."}</EmptyState>}
        </Card>
      </div>

      <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-4">
        <TestActivation concept={concept} />
        <Card title="Top activations" aside={rows.length ? plural(rows.length, "message") : undefined} testid="top-activations">
          {rows.length === 0 && <EmptyState>No readings exist for this feature yet. A fork that watches it fills this list.</EmptyState>}
          <ol className="m-0 flex list-none flex-col p-0">
            {shownRows.map((r, i) => (
              <li key={`${r.agent}-${r.step}-${i}`} className="flex flex-col gap-1 border-t border-divider py-2.5 first:border-t-0">
                <div className="num flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-text-3">
                  <span className="text-[13px] text-accent-text">{fmt(r.activation)}</span>
                  <span>{r.agent}</span>
                  <span>step {r.step}</span>
                  {r.seed !== undefined && <span>seed {r.seed}</span>}
                  <span className="chip">{r.config}</span>
                </div>
                <p className="message m-0 text-[13px] leading-normal text-text-2">{visibleText(r.text)}</p>
              </li>
            ))}
          </ol>
          {rows.length > 6 && (
            <button type="button" className="btn self-start" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show the first 6" : `Show all ${rows.length}`}
            </button>
          )}
        </Card>
        <AcrossSwarm concept={concept} />
      </div>
    </div>
  );
}

function LogitList({ title, rows, tone }: { title: string; rows: { token: string; value: number }[]; tone: "pos" | "neg" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="lbl pb-1">{title}</span>
      {rows.map((g, i) => (
        <span key={i} className={`num flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-[12px] ${tone === "pos" ? "bg-accent-bg" : "bg-warn-bg"}`}>
          <span className="truncate">{visibleToken(g.token)}</span>
          <span className={tone === "pos" ? "text-accent-text" : "text-warn-text"}>{fmt(g.value)}</span>
        </span>
      ))}
    </div>
  );
}

function TestActivation({ concept }: { concept: ConceptPage }) {
  const [text, setText] = useState("The plan will not work, and I doubt anyone here can fix it.");
  const [out, setOut] = useState<TokenActivations | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOut(null);
    setBlocked(null);
    setError(null);
  }, [concept.model, concept.source, concept.index]);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOut(null);
    setBlocked(null);
    setError(null);
    try {
      setOut(await post<TokenActivations>(`${conceptPath(concept.model, concept.source, concept.index)}/test`, { text }));
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409) setBlocked(apiErr.message);
      else setError(apiErr);
    } finally {
      setBusy(false);
    }
  };
  const peak = out ? Math.max(0, ...out.activations) : 0;
  return (
    <Card title="Test activation" testid="test-activation">
      <form onSubmit={run} className="flex flex-wrap gap-2">
        <label htmlFor="test-text" className="sr-only">Text to test</label>
        <input id="test-text" className="field h-10 min-w-[240px] flex-1 text-[14px]" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn h-10" disabled={busy || !text.trim()} data-testid="test-run">
          {busy ? "Running" : "Test"}
        </button>
      </form>
      {blocked && <EmptyState testid="test-blocked">{blocked}</EmptyState>}
      <ErrorNote error={error} />
      {out && (
        <>
          <p className="m-0 flex flex-wrap gap-px text-[15px] leading-loose" data-testid="test-tokens">
            {out.tokens.map((t, i) => {
              const v = out.activations[i] ?? 0;
              const share = peak > 0 ? Math.max(0, v) / peak : 0;
              return (
                <span key={i} title={`Activation ${fmt(v)}`} className="rounded-[3px] px-0.5" style={{ background: share > 0 ? activationColor(share) : "transparent", color: share > 0.75 ? "#0B0C0F" : undefined }}>
                  {visibleToken(t)}
                </span>
              );
            })}
          </p>
          <span className="num text-[12px] text-text-3">Largest activation {fmt(peak)}</span>
        </>
      )}
    </Card>
  );
}

function AcrossSwarm({ concept }: { concept: ConceptPage }) {
  const params = useSearchParams();
  const list = useFetch<ExperimentList>("/experiments");
  const options = useMemo(() => (concept.live ? (list.data?.live ?? []).map((e) => e.id) : (list.data?.recorded ?? []).map((e) => e.id)), [concept.live, list.data]);
  const [experiment, setExperiment] = useState<string | null>(params.get("exp"));
  const [step, setStep] = useState<number | null>(params.get("step") ? Number(params.get("step")) : null);
  const preferred = options.includes("scale-50-negative-lead") ? "scale-50-negative-lead" : options[0];
  const active = experiment && options.includes(experiment) ? experiment : (preferred ?? null);
  const swarmPath = active ? `${conceptPath(concept.model, concept.source, concept.index)}/swarm?experiment=${encodeURIComponent(active)}${step !== null ? `&step=${step}` : ""}` : null;
  const swarm = useFetch<ConceptSwarm>(swarmPath, { keepPrevious: true });
  const detail = useFetch<ExperimentDetail>(active ? `/experiments/${encodeURIComponent(active)}` : null);

  const data = swarm.data;
  const steps = useMemo(() => Object.keys(data?.per_step_mean ?? {}).map(Number).sort((a, b) => a - b), [data?.per_step_mean]);
  const domain = useMemo<ColorDomain | null>(() => {
    const vals = Object.values(data?.agents ?? {}).sort((a, b) => a - b);
    if (!vals.length) return null;
    const lo = vals[Math.floor(vals.length * 0.02)];
    const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
    return { kind: "sequential", lo, hi: hi > lo ? hi : lo + 1 };
  }, [data?.agents]);
  const roster = detail.data?.agents ?? [];
  const roles = [...new Set(roster.map((a) => a.role))];
  const branch = concept.live ? "control branch of a fork of this experiment" : "treatment branch, seed 1";

  return (
    <Card title="Across the swarm" aside={data?.step !== null && data?.step !== undefined ? `step ${data.step}` : undefined} testid="across-swarm">
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="c-exp" className="lbl">Experiment</label>
        <select id="c-exp" className="field" value={active ?? ""} onChange={(e) => { setExperiment(e.target.value); setStep(null); }} disabled={!options.length}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {data && !data.empty && <span className="note">Shows the {branch}.</span>}
      </div>
      {!active && list.data && <EmptyState>No live experiment exists yet. Create one on the <Link href="/intervene">Intervene screen</Link>, then fork it.</EmptyState>}
      {swarm.error && <ErrorNote error={swarm.error} />}
      {data?.empty && <EmptyState>{data.empty}</EmptyState>}
      {data && !data.empty && roster.length > 0 && (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[320px] flex-[3_1_420px]">
            <SwarmMap agents={roster} edges={detail.data?.edges} values={data.agents} domain={domain} height={340} label={`Activation across the swarm for ${concept.label ?? `feature ${concept.index}`}`} valueLabel="Activation" />
          </div>
          <div className="flex min-w-[200px] flex-[1_1_220px] flex-col gap-2">
            <span className="cap">By role</span>
            {Object.keys(data.role_means).length === 0 && <span className="note">No readings at this step.</span>}
            {Object.entries(data.role_means).map(([role, mean]) => (
              <div key={role} className="flex items-center justify-between border-t border-divider py-1.5 text-[13px]">
                <span className="text-text-2">{role}</span>
                <span className="num">{fmt(mean)}</span>
              </div>
            ))}
            <span className="cap pt-2">Mean by step</span>
            <PerStepMean perStep={data.per_step_mean} step={data.step} onPick={setStep} />
          </div>
        </div>
      )}
      {data && !data.empty && <StepScrubber steps={steps} step={data.step} onChange={setStep} />}
      {data && !data.empty && <MapLegend domain={domain} roles={roles} showTargets={false} valueLabel="Activation at this step" note="Values beyond the printed range take the end colour." />}
    </Card>
  );
}
