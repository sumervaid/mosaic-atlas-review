"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { type ApiError, request, useFetch } from "@/lib/api";
import { activationColor } from "@/lib/color";
import { fmt, plural, visibleToken } from "@/lib/format";
import type { ExplanationResult, InferenceResult, SearchResponse } from "@/lib/types";
import { Main } from "./shell";
import { Card, EmptyState, ErrorNote, PageTitle, Tabs, TestModelBanner } from "./ui";

type Mode = "explanations" | "inference";

export function SearchScreen() {
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "inference" ? "inference" : "explanations");
  const [isTest, setIsTest] = useState(false);
  return (
    <>
      {mode === "inference" && isTest && <TestModelBanner />}
      <Main narrow>
        <PageTitle title="Search">Find concepts by searching their explanations, or by running text through a loaded model.</PageTitle>
        <Tabs<Mode> label="Search mode" value={mode} onChange={setMode} options={[{ value: "explanations", label: "Search explanations" }, { value: "inference", label: "Search via inference" }]} />
        {mode === "explanations" ? <ExplanationSearch initial={params.get("q") ?? ""} /> : <InferenceSearch initial={params.get("text") ?? ""} onKind={setIsTest} />}
      </Main>
    </>
  );
}

function ExplanationSearch({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const res = useFetch<SearchResponse<ExplanationResult>>(`/concepts/search?mode=explanations&q=${encodeURIComponent(submitted)}`);
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q);
        }}
      >
        <label htmlFor="q" className="sr-only">Search explanations</label>
        <input id="q" type="search" className="field h-11 flex-1 text-[15px]" placeholder="Search explanations, such as negative affect" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn btn-primary">Search</button>
      </form>
      <ErrorNote error={res.error} />
      <Card title="Results" aside={res.data ? plural(res.data.results.length, "concept") : undefined} testid="explanation-results">
        {res.data?.results.length === 0 && <EmptyState>No explanation matches {submitted ? `"${submitted}"` : "this search"}.</EmptyState>}
        <ul className="m-0 flex list-none flex-col p-0">
          {res.data?.results.map((r) => (
            <li key={`${r.model}-${r.source}-${r.index}`} className="border-t border-divider py-3 first:border-t-0">
              <Link href={`/concept?model=${encodeURIComponent(r.model)}&source=${encodeURIComponent(r.source)}&index=${r.index}`} className="flex flex-col gap-1 no-underline">
                <span className="num text-[11px] text-accent-text">
                  {r.model} / {r.source} / {r.index}
                </span>
                <span className="text-[15px] font-medium text-text">{r.label}</span>
                <span className="text-[13px] leading-normal text-text-2">{r.explanation}</span>
              </Link>
            </li>
          ))}
        </ul>
        {res.data?.note && <p className="note m-0">{res.data.note}</p>}
      </Card>
    </>
  );
}

const SAMPLE = "The lead disagreed with the plan, and the team deferred.";

function InferenceSearch({ initial, onKind }: { initial: string; onKind: (isTest: boolean) => void }) {
  const [text, setText] = useState(initial || SAMPLE);
  const [res, setRes] = useState<SearchResponse<InferenceResult> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<number | null>(null);

  useEffect(() => {
    onKind(!!res?.is_test_model);
    return () => onKind(false);
  }, [res?.is_test_model, onKind]);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setToken(null);
    try {
      setRes(await request<SearchResponse<InferenceResult>>(`/concepts/search?mode=inference&text=${encodeURIComponent(text)}`));
    } catch (err) {
      setRes(null);
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const tokens = res?.tokens ?? [];
  const peakByToken = new Map<number, number>();
  for (const r of res?.results ?? []) peakByToken.set(r.token_index, Math.max(peakByToken.get(r.token_index) ?? 0, r.max_act));
  const peak = Math.max(0, ...peakByToken.values());
  const shown = (res?.results ?? []).filter((r) => token === null || r.token_index === token);
  const top = Math.max(1e-9, ...shown.map((r) => r.max_act));
  const modelId = res?.is_test_model ? "test-tiny-gemma3" : (res?.model ?? "");

  return (
    <>
      <form className="card flex flex-col gap-3 p-4" onSubmit={run}>
        <label htmlFor="infer" className="cap">Text</label>
        <textarea id="infer" className="area" rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="inference-text" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="note">This runs on the test model unless a GPU model is loaded.</span>
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} data-testid="inference-run">
            {busy ? "Searching" : "Search"}
          </button>
        </div>
      </form>
      <ErrorNote error={error} />
      {!res && !error && <EmptyState>Run the search to see which features fire on each token.</EmptyState>}
      {res && (
        <>
          <Card title="Tokens" aside={token === null ? "Click a token to filter" : `Filtered to token ${token}`} testid="token-strip">
            <div className="flex flex-wrap gap-1">
              {tokens.map((t, i) => {
                const v = peakByToken.get(i) ?? 0;
                const share = peak > 0 ? v / peak : 0;
                const on = token === i;
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Token ${i}, ${t.trim() || "space"}. Filter results.`}
                    onClick={() => setToken(on ? null : i)}
                    className={`num h-8 min-w-6 rounded border px-1.5 text-[13px] ${on ? "border-text" : "border-border-input"}`}
                    style={{ background: v > 0 ? activationColor(share) : undefined, color: share > 0.75 ? "#0B0C0F" : undefined }}
                  >
                    {visibleToken(t)}
                  </button>
                );
              })}
            </div>
            {token !== null && (
              <button type="button" className="btn self-start" onClick={() => setToken(null)}>Clear the filter</button>
            )}
          </Card>
          <Card title="Active features" aside={plural(shown.length, "result")} testid="inference-results">
            {shown.length === 0 && <EmptyState>No listed feature peaks on this token. The API returns the most active features overall.</EmptyState>}
            {shown.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-[12px] text-text-3">
                      <th scope="col" className="pb-2 font-normal">Feature</th>
                      <th scope="col" className="pb-2 font-normal">Source</th>
                      <th scope="col" className="pb-2 font-normal">Peak token</th>
                      <th scope="col" className="pb-2 text-right font-normal">Largest activation</th>
                      <th scope="col" className="w-[220px] pb-2 pl-4 font-normal"><span className="sr-only">Bar</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={`${r.feature}-${r.token_index}`} className="border-t border-divider">
                        <td className="py-2">
                          <Link className="num" href={`/concept?model=${encodeURIComponent(modelId)}&source=${encodeURIComponent(r.source)}&index=${r.feature}`}>
                            Feature {r.feature}
                          </Link>
                        </td>
                        <td className="num py-2 text-[12px] text-text-3">{r.source}</td>
                        <td className="num py-2 text-text-2">
                          <span className="chip">{visibleToken(r.token)}</span> at {r.token_index}
                        </td>
                        <td className="num py-2 text-right">{fmt(r.max_act)}</td>
                        <td className="py-2 pl-4">
                          <span aria-hidden="true" className="block h-1.5 rounded bg-divider">
                            <span className="block h-1.5 rounded bg-accent" style={{ width: `${(r.max_act / top) * 100}%` }} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
