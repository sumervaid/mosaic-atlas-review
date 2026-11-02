"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type ApiError, post, useFetch } from "@/lib/api";
import { connections, pruneEdges, rankRecipients } from "@/lib/contagion";
import { fmt, plural, visibleText } from "@/lib/format";
import { teamsOf } from "@/lib/swarm";
import { scales } from "@/lib/tokens";
import type { ContagionEdge, ContagionGraph, ExperimentDetail, ExperimentList } from "@/lib/types";
import { LinkGraph } from "./link-graph";
import { Main, SelectorBar } from "./shell";
import { BarLabel, Card, EmptyState, ErrorNote, Field, Loading, RecordedLabel, TestModelBanner } from "./ui";

export function ContagionScreen() {
  const params = useSearchParams();
  const list = useFetch<ExperimentList>("/experiments");
  const [experiment, setExperiment] = useState(params.get("exp") ?? "pilot-negative-lead");
  const [feature, setFeature] = useState(Number(params.get("feature") ?? 3));
  const [prune, setPrune] = useState(0);
  const [team, setTeam] = useState<number | "all" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("exp", experiment);
    window.history.replaceState(null, "", url.toString());
  }, [experiment]);

  const recordedEntry = list.data?.recorded.find((e) => e.id === experiment);
  const isRecorded = !!recordedEntry;
  const detail = useFetch<ExperimentDetail>(!isRecorded && list.data ? `/experiments/${encodeURIComponent(experiment)}` : null);
  const watch = detail.data?.config?.watch_features ?? [];
  const graph = useFetch<ContagionGraph>(`/contagion/${encodeURIComponent(experiment)}/graph?feature=${isRecorded ? 0 : feature}&prune=0`, { keepPrevious: true });
  const g = graph.data;
  const agents = useMemo(() => g?.agents ?? [], [g]);
  const teams = useMemo(() => teamsOf(agents), [agents]);
  const isTest = !!g?.is_test_model;

  useEffect(() => {
    setPrune(0);
    setSelected(null);
    setTeam(null);
  }, [experiment]);

  // Large swarms open on one team, so each message is big enough to click. Every other team is one choice away.
  const activeTeam = team ?? (agents.length > 64 && teams.length ? teams[0] : "all");
  const rows = useMemo(() => (activeTeam === "all" ? agents : agents.filter((a) => a.team === activeTeam || a.role === "Coordinator")), [agents, activeTeam]);
  const peak = useMemo(() => Math.max(0, ...(g?.edges ?? []).map((e) => Math.abs(e.weight))), [g]);
  const edges = useMemo(() => pruneEdges(g?.edges ?? [], prune), [g, prune]);
  const node = g?.nodes.find((n) => n.id === selected) ?? null;

  return (
    <>
      <SelectorBar>
        <BarLabel htmlFor="g-exp">Experiment</BarLabel>
        <select id="g-exp" className="field max-w-[300px]" value={experiment} onChange={(e) => setExperiment(e.target.value)} data-testid="contagion-experiment">
          {!list.data && <option value={experiment}>{experiment}</option>}
          <optgroup label="Recorded comparisons">
            {list.data?.recorded.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </optgroup>
          <optgroup label="Live experiments">
            {list.data?.live.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </optgroup>
        </select>
        {!isRecorded && watch.length > 0 && (
          <>
            <BarLabel htmlFor="g-feature">Feature</BarLabel>
            <select id="g-feature" className="field num" value={feature} onChange={(e) => setFeature(Number(e.target.value))} data-testid="contagion-feature">
              {watch.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        {teams.length > 1 && (
          <>
            <BarLabel htmlFor="g-team">Team</BarLabel>
            <select id="g-team" className="field" value={String(activeTeam)} onChange={(e) => setTeam(e.target.value === "all" ? "all" : Number(e.target.value))} data-testid="contagion-team">
              <option value="all">All teams</option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  Team {t}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="g-prune" className="cap ml-1">Pruning</label>
        <input id="g-prune" type="range" className="h-7 w-36" min={0} max={peak || 1} step={(peak || 1) / 100} value={prune} disabled={!peak} onChange={(e) => setPrune(Number(e.target.value))} data-testid="contagion-prune" />
        <span className="num text-[12px] text-text-2">{peak ? `|weight| at least ${fmt(prune)}` : "No measured weights"}</span>
        <span className="flex-1" />
        {isRecorded && <RecordedLabel model={recordedEntry?.model} />}
      </SelectorBar>
      {isTest && <TestModelBanner />}
      <Main>
        <div className="flex max-w-[860px] flex-col gap-1.5">
          <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]">Contagion tracer</h1>
          <p className="m-0 text-[14px] leading-relaxed text-text-2">Each dot is one message. Each weighted edge is a measurement. MOSAIC replays the run without a message and reads what changes in the agent that would have read it.</p>
        </div>
        {graph.error && <ErrorNote error={graph.error} />}
        {g?.empty && (
          <div role="status" data-testid="contagion-empty" className="rounded-lg border border-border-input bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-text">
            {g.empty}
            {!isRecorded && !g.nodes.length && (
              <>
                {" "}
                <Link href={`/intervene?exp=${encodeURIComponent(experiment)}`}>Open Intervene.</Link>
              </>
            )}
          </div>
        )}
        {graph.loading && !g && <Loading what="the graph" />}
        {g && g.nodes.length > 0 && (
          <div className="flex flex-wrap items-start gap-4">
            <Card title="Link graph" aside={`${plural(rows.length, "agent")}. ${plural(edges.length, "measured edge")}.`} className="min-w-0 flex-[999_1_640px]" testid="graph-card">
              <LinkGraph agents={rows} nodes={g.nodes} edges={edges} selected={selected} onSelect={setSelected} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full bg-[#4A4D58]" />
                  Message
                </span>
                {g.edges.length > 0 && (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="h-[3px] w-5 rounded" style={{ background: scales.difference[2] }} />
                      Message raised the reader&apos;s activation
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="h-[3px] w-5 rounded" style={{ background: scales.difference[0] }} />
                      Message lowered it
                    </span>
                  </>
                )}
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full shadow-[0_0_0_2px_var(--color-warn)]" />
                  Selected
                </span>
                {g.edges.length > 0 && <span>Printed weights are activation kept minus activation without the message.</span>}
              </div>
            </Card>
            <ConnectionsPanel g={g} experiment={experiment} feature={isRecorded ? 0 : feature} isRecorded={isRecorded} selected={selected} onSelect={setSelected} edges={edges} onMeasured={(edge) => { graph.reload(); setPrune(0); const a = agents.find((x) => x.id === edge.from); if (a && activeTeam !== "all" && a.team !== activeTeam) setTeam(a.team); }} />
          </div>
        )}
        {g && node && (
          <Card title={`Message from ${node.agent} at step ${node.step}`} testid="message-card">
            <p className="message m-0 rounded-md bg-bg p-3 text-[14px] leading-normal">{visibleText(node.text)}</p>
            <span className="num text-[11px] text-text-3">
              {node.id}
              {g.seed !== undefined ? `. Seed ${g.seed}.` : ""}
            </span>
          </Card>
        )}
      </Main>
    </>
  );
}

function EdgeRow({ e, direction, onPick }: { e: ContagionEdge; direction: "in" | "out"; onPick: () => void }) {
  const colour = e.weight < 0 ? scales.difference[0] : scales.difference[2];
  return (
    <button type="button" onClick={onPick} className="grid w-full grid-cols-[1fr_auto] items-center gap-2 border-0 border-t border-divider bg-transparent py-2 text-left text-[12px] text-text-2 hover:bg-chip" data-testid="edge-row">
      <span className="flex min-w-0 flex-col">
        <span className="num text-accent-text">{direction === "in" ? `From ${e.from}` : `To ${e.to}`}, step {direction === "in" ? e.step : e.step + 1}</span>
        <span className="text-text-3">
          {plural(e.replicates, "replicate")}. {e.method}.
          {e.recipient_silent_without_message > 0 ? ` Recipient stayed silent without the message in ${e.recipient_silent_without_message}.` : ""}
        </span>
      </span>
      <span className="num text-[13px]" style={{ color: colour }}>{fmt(e.weight)}</span>
    </button>
  );
}

function ConnectionsPanel({ g, experiment, feature, isRecorded, selected, onSelect, edges, onMeasured }: { g: ContagionGraph; experiment: string; feature: number; isRecorded: boolean; selected: string | null; onSelect: (id: string) => void; edges: ContagionEdge[]; onMeasured: (e: ContagionEdge) => void }) {
  const node = g.nodes.find((n) => n.id === selected) ?? null;
  const [recipient, setRecipient] = useState("");
  const [replicates, setReplicates] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const focusNode = node;
  const ranked = useMemo(() => (node ? rankRecipients(node, g.nodes) : []), [node, g.nodes]);

  useEffect(() => {
    setError(null);
    setRecipient(ranked[0]?.id ?? "");
  }, [ranked]);

  const replay = async () => {
    if (!node || !g.fork_id) return;
    setBusy(true);
    setError(null);
    try {
      const edge = await post<ContagionEdge>(`/contagion/${encodeURIComponent(experiment)}/ablate`, {
        fork_id: g.fork_id,
        message_id: node.id,
        recipient,
        feature,
        replicates: Math.max(1, Number(replicates) || 1),
      });
      onMeasured(edge);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const conn = focusNode ? connections(focusNode, edges) : { input: [], output: [] };
  return (
    <Card title="Node connections" className="min-w-[300px] flex-[1_1_340px] lg:max-w-[420px]" testid="connections">
      {!focusNode && <EmptyState>Choose a message on the graph to see its measured connections.</EmptyState>}
      {focusNode && (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-[18px] font-semibold">{focusNode.agent}</span>
            <span className="num text-[12px] text-text-3">
              {focusNode.id}. Step {focusNode.step}.
            </span>
          </div>
          <div className="flex flex-col">
            <span className="cap pb-1.5">Input</span>
            {conn.input.length === 0 && <span className="note">No measured edge reaches this message.</span>}
            {conn.input.map((e) => (
              <EdgeRow key={`${e.message_id}-${e.to}`} e={e} direction="in" onPick={() => onSelect(e.message_id)} />
            ))}
          </div>
          <div className="flex flex-col">
            <span className="cap pb-1.5">Output</span>
            {conn.output.length === 0 && <span className="note">No measured edge leaves this message.</span>}
            {conn.output.map((e) => (
              <EdgeRow key={`${e.message_id}-${e.to}`} e={e} direction="out" onPick={() => { const reader = g.nodes.find((n) => n.agent === e.to && n.step === e.step + 1); if (reader) onSelect(reader.id); }} />
            ))}
          </div>
          <div className="flex flex-col gap-2.5 border-t border-divider pt-3" data-testid="replay">
            {isRecorded ? (
              <p className="note m-0">Replay needs a loaded model. Recorded runs are read only.</p>
            ) : ranked.length === 0 ? (
              <p className="note m-0">This message has no recipients to replay.</p>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_88px] gap-3">
                  <Field label="Recipient">
                    {(id) => (
                      <select id={id} className="field w-full" value={recipient} onChange={(e) => setRecipient(e.target.value)} data-testid="replay-recipient">
                        {ranked.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.id}
                            {r.speaksNext ? "" : ". Silent next step"}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Replicates">{(id) => <input id={id} className="field num w-full" inputMode="numeric" value={replicates} onChange={(e) => setReplicates(e.target.value)} />}</Field>
                </div>
                <button type="button" className="btn" disabled={busy || !recipient} onClick={replay} data-testid="replay-button">
                  {busy ? "Replaying" : "Replay without this message"}
                </button>
                <ErrorNote error={error} />
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
