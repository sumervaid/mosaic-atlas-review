"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type ApiError, post, useFetch } from "@/lib/api";
import { fmt, plural, prettyModel, visibleText } from "@/lib/format";
import type { AgentComparison, ExperimentList, ForkResults, ModelEntry, SteerResponse } from "@/lib/types";
import { TraceChart } from "./charts";
import { Main, SelectorBar } from "./shell";
import { BarLabel, Card, EmptyState, ErrorNote, Field, Loading, PageTitle, RecordedLabel, Seg, Tabs, TestModelBanner } from "./ui";

type Tab = "recorded" | "live";

export function SteerScreen() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "live" ? "live" : "recorded");
  const [isTest, setIsTest] = useState(false);
  return (
    <>
      {tab === "live" && isTest && <TestModelBanner />}
      {tab === "recorded" ? <Recorded tab={tab} setTab={setTab} /> : <Live tab={tab} setTab={setTab} onKind={setIsTest} />}
    </>
  );
}

function TabRow({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return <Tabs<Tab> label="Steer data" value={tab} onChange={setTab} options={[{ value: "recorded", label: "Recorded" }, { value: "live", label: "Live" }]} />;
}

function Recorded({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const params = useSearchParams();
  const list = useFetch<ExperimentList>("/experiments");
  const [comparison, setComparison] = useState(params.get("exp") ?? "pilot-negative-lead");
  const entry = list.data?.recorded.find((e) => e.id === comparison);
  const results = useFetch<ForkResults>(`/forks/${encodeURIComponent(comparison)}/results`);
  const res = results.data?.fork_id === comparison ? results.data : null;
  const [seed, setSeed] = useState<number | null>(null);
  const [agent, setAgent] = useState<string | null>(null);

  useEffect(() => {
    setSeed(null);
    setAgent(null);
  }, [comparison]);

  const useSeed = seed ?? res?.map_seed ?? entry?.seeds[0] ?? null;
  const useAgent = agent ?? res?.targets[0] ?? null;
  const path = useSeed !== null && useAgent ? `/steer/recorded?comparison=${encodeURIComponent(comparison)}&seed=${useSeed}&agent=${encodeURIComponent(useAgent)}` : null;
  const data = useFetch<AgentComparison>(path);
  const pairs = useMemo(() => {
    if (!data.data) return [];
    const steps = [...new Set([...data.data.control, ...data.data.treatment].map((m) => m.step))].sort((a, b) => a - b);
    return steps.map((s) => ({ step: s, def: data.data?.control.find((m) => m.step === s), steered: data.data?.treatment.find((m) => m.step === s) }));
  }, [data.data]);
  const isTarget = useAgent && res?.targets.includes(useAgent);
  // One recorded comparison changes a prompt and leaves activations alone, so its column cannot say steered.
  const changed = /no steering/i.test(entry?.description ?? "") ? "Treatment" : "Steered";

  return (
    <>
      <SelectorBar>
        <BarLabel htmlFor="s-comp">Comparison</BarLabel>
        <select id="s-comp" className="field" value={comparison} onChange={(e) => setComparison(e.target.value)} data-testid="steer-comparison">
          {list.data?.recorded.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id}
            </option>
          ))}
        </select>
        <BarLabel htmlFor="s-seed">Seed</BarLabel>
        <select id="s-seed" className="field num w-20" value={useSeed ?? ""} onChange={(e) => setSeed(Number(e.target.value))}>
          {entry?.seeds.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <BarLabel htmlFor="s-agent">Agent</BarLabel>
        <select id="s-agent" className="field" value={useAgent ?? ""} onChange={(e) => setAgent(e.target.value)} data-testid="steer-agent">
          {res?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}. {a.role}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <RecordedLabel model={entry?.model} />
      </SelectorBar>
      <Main>
        <PageTitle title="Steer">
          Compare what an AI agent said in the default run and in the changed run. {data.data?.description ?? entry?.description}
        </PageTitle>
        <TabRow tab={tab} setTab={setTab} />
        {results.error && <ErrorNote error={results.error} />}
        {data.error && <ErrorNote error={data.error} />}
        {data.loading && !data.data && <Loading what="the messages" />}
        {data.data && pairs.length === 0 && (
          <EmptyState testid="steer-empty">
            {data.data.agent} has no messages in seed {useSeed}. Each recorded seed draws its own named agents, and the API lists the roster of seed {res?.map_seed} only.
          </EmptyState>
        )}
        {data.data && pairs.length > 0 && (
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-3" data-testid="steer-rounds">
              <div className="hidden grid-cols-[64px_1fr_1fr] gap-3 px-3 md:grid">
                <span />
                <span className="cap">Default</span>
                <span className="cap !text-accent-text">{changed}</span>
              </div>
              {pairs.map((p) => {
                const first = p.step === data.data?.first_divergence;
                return (
                  <section key={p.step} aria-label={`Round ${p.step}`} className="card grid gap-3 p-3 md:grid-cols-[64px_1fr_1fr]">
                    <div className="flex flex-col gap-1">
                      <span className="num text-[12px] text-text-2">Round {p.step}</span>
                      {first && <span className="text-[11px] leading-tight text-warn-text">First divergence</span>}
                    </div>
                    <p className="message m-0 rounded-md bg-bg p-2.5 text-[13px] leading-normal text-text-2">{p.def ? visibleText(p.def.text) : "No message in this round."}</p>
                    <p className="message m-0 rounded-md bg-accent-bg p-2.5 text-[13px] leading-normal text-text">{p.steered ? visibleText(p.steered.text) : "No message in this round."}</p>
                  </section>
                );
              })}
            </div>
            <div className="sticky top-4 flex min-w-[280px] flex-[1_1_320px] flex-col gap-4 lg:max-w-[380px]">
              <Card title="This agent">
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  <dt className="text-text-3">Agent</dt>
                  <dd className="m-0 text-right">{data.data.agent}</dd>
                  <dt className="text-text-3">Changed directly</dt>
                  <dd className="m-0 text-right">{isTarget ? "Yes" : `No. The change went to ${res?.targets.join(", ")}.`}</dd>
                  <dt className="text-text-3">Seed</dt>
                  <dd className="num m-0 text-right">{data.data.replicate}</dd>
                  <dt className="text-text-3">Rounds</dt>
                  <dd className="num m-0 text-right">{pairs.length}</dd>
                  <dt className="text-text-3">Model</dt>
                  <dd className="m-0 text-right">{prettyModel(entry?.model)}</dd>
                </dl>
                <p className="note m-0">
                  Both columns are real messages from the pilot, under the same seed. The chart reads {res?.concept.label ?? "the recorded direction"}.
                </p>
              </Card>
              {data.data.trace.length > 0 && (
                <Card title="Activation by round">
                  <TraceChart trace={data.data.trace} firstDivergence={data.data.first_divergence} controlLabel="Default" treatmentLabel={changed} />
                </Card>
              )}
            </div>
          </div>
        )}
      </Main>
    </>
  );
}

function Live({ tab, setTab, onKind }: { tab: Tab; setTab: (t: Tab) => void; onKind: (isTest: boolean) => void }) {
  const models = useFetch<ModelEntry[]>("/models");
  const liveModels = (models.data ?? []).filter((m) => m.live);
  const [model, setModel] = useState("test-tiny-gemma3");
  const [prompt, setPrompt] = useState("Write one sentence to your team about the plan.");
  const [target, setTarget] = useState<"vector" | "feature">("vector");
  const [vector, setVector] = useState("test-vector");
  const [feature, setFeature] = useState("3");
  const [strength, setStrength] = useState("300");
  const [temperature, setTemperature] = useState("0.8");
  const [tokens, setTokens] = useState("48");
  const [seed, setSeed] = useState("0");
  const [out, setOut] = useState<SteerResponse | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onKind(out ? out.is_test_model : model === "test-tiny-gemma3");
    return () => onKind(false);
  }, [out, model, onKind]);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const numbers = { strength: Number(strength), temperature: Number(temperature), max_new_tokens: Number(tokens), seed: Number(seed) };
    if (Object.values(numbers).some((n) => !Number.isFinite(n)) || (target === "feature" && !Number.isInteger(Number(feature)))) {
      setError("Strength, temperature, tokens, seed, and feature must be numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setOut(await post<SteerResponse>("/steer/chat", { prompt, model, ...numbers, ...(target === "vector" ? { vector_id: vector } : { feature: Number(feature) }) }));
    } catch (err) {
      setOut(null);
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Main>
      <PageTitle title="Steer">Send one prompt twice to a loaded model, with and without a steering change. Both runs share a seed.</PageTitle>
      <TabRow tab={tab} setTab={setTab} />
      <div className="flex flex-wrap items-start gap-4">
        <form onSubmit={run} className="card flex min-w-[280px] flex-[1_1_320px] flex-col gap-3 p-4 lg:max-w-[380px]">
          <Field label="Model">
            {(id) => (
              <select id={id} className="field w-full" value={model} onChange={(e) => setModel(e.target.value)}>
                {liveModels.map((m) => (
                  <option key={m.id} value={m.name ?? m.id} disabled={!m.available}>
                    {m.name ?? m.id}. {m.kind === "test" ? "test model" : m.available ? "loaded" : "not loaded"}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Prompt">{(id) => <textarea id={id} className="area" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />}</Field>
          <Seg label="Steer with" value={target} onChange={setTarget} options={[{ value: "vector", label: "Vector" }, { value: "feature", label: "Feature" }]} />
          <div className="grid grid-cols-2 gap-3">
            {target === "vector" ? (
              <Field label="Vector id">{(id) => <input id={id} className="field num w-full" value={vector} onChange={(e) => setVector(e.target.value)} />}</Field>
            ) : (
              <Field label="Feature index">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={feature} onChange={(e) => setFeature(e.target.value)} />}</Field>
            )}
            <Field label="Strength">{(id) => <input id={id} className="field num w-full" inputMode="decimal" value={strength} onChange={(e) => setStrength(e.target.value)} />}</Field>
            <Field label="Temperature">{(id) => <input id={id} className="field num w-full" inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} />}</Field>
            <Field label="Max new tokens">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} />}</Field>
            <Field label="Seed">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} />}</Field>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !prompt.trim()} data-testid="steer-run">
            {busy ? "Running" : "Steer"}
          </button>
          <ErrorNote error={error} />
        </form>
        <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-3">
          {!out && !error && <EmptyState>Run a prompt to see the default and steered completions.</EmptyState>}
          {out && (
            <>
              <div className="grid gap-3 md:grid-cols-2" data-testid="steer-live-result">
                <Card title="Default">
                  <p className="message m-0 text-[14px] leading-normal text-text-2">{visibleText(out.default) || "The model returned no text."}</p>
                </Card>
                <Card title="Steered" className="!bg-accent-bg">
                  <p className="message m-0 text-[14px] leading-normal">{visibleText(out.steered) || "The model returned no text."}</p>
                </Card>
              </div>
              <p className="note m-0">
                {out.identical ? "The two completions are identical, token for token." : "The two completions differ."} Model {out.model}. Seed {out.seed}. Strength {fmt(Number(strength))}. {plural(Number(tokens), "token")} at most.
              </p>
            </>
          )}
        </div>
      </div>
    </Main>
  );
}
