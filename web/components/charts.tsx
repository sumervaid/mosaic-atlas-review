"use client";

import { useWidth } from "@/lib/api";
import { fmt, fmtInterval, fmtPercent, fmtTick, hopLabel, niceTicks, plural } from "@/lib/format";
import { scales, tokens } from "@/lib/tokens";
import type { Estimate, ForkResults, HopEffect, Outcome, TracePoint } from "@/lib/types";

const AXIS = tokens.text4;
const GRID = "#262830";
const ZERO = "#4A4D58";
const NOISE = "#5A5E6A";
const TICK = { fontFamily: "var(--font-mono)", fontSize: 10, fill: AXIS } as const;

function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

function everyNth<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  const stride = Math.ceil(items.length / maxCount);
  return items.filter((_, i) => i % stride === 0);
}

/** Paired bars per step. Blue is treatment. Grey is the control-versus-control noise floor, when measured. */
export function DivergenceFront({ res }: { res: Pick<ForkResults, "front" | "steps"> }) {
  const [ref, width] = useWidth<HTMLDivElement>(340);
  const { treatment, noise_floor } = res.front;
  const H = 214;
  const m = { l: 42, r: 8, t: 8, b: 32 };
  const peak = Math.max(0, ...treatment, ...(noise_floor ?? []));
  const top = peak === 0 ? 1 : peak > 0.5 ? 1 : peak * 1.15;
  const ticks = niceTicks(0, top, 4);
  const y = linear(0, top, H - m.b, m.t);
  const band = (width - m.l - m.r) / Math.max(1, res.steps.length);
  const hasNoise = !!noise_floor;
  const barW = Math.max(1.5, Math.min(hasNoise ? band * 0.36 : band * 0.6, 22));
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={H} role="img" aria-label={`Share of AI agents whose messages differ from control, by step. Peak ${fmtPercent(peak)}.`} data-testid="front-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} />
            <text x={m.l - 6} y={y(t) + 3} textAnchor="end" style={TICK}>
              {fmtPercent(t)}
            </text>
          </g>
        ))}
        {res.steps.map((s, i) => {
          const cx = m.l + band * (i + 0.5);
          const tv = treatment[i];
          const nv = noise_floor?.[i];
          return (
            <g key={s}>
              {tv !== undefined && <rect x={hasNoise ? cx - barW - 0.5 : cx - barW / 2} y={y(tv)} width={barW} height={Math.max(tv > 0 ? 1 : 0, y(0) - y(tv))} fill={tokens.accent} rx={1} />}
              {hasNoise && nv !== undefined && <rect x={cx + 0.5} y={y(nv)} width={barW} height={Math.max(nv > 0 ? 1 : 0, y(0) - y(nv))} fill={NOISE} rx={1} />}
            </g>
          );
        })}
        {everyNth(res.steps, Math.floor(width / 32)).map((s) => (
          <text key={s} x={m.l + band * (res.steps.indexOf(s) + 0.5)} y={H - m.b + 13} textAnchor="middle" style={TICK}>
            {s}
          </text>
        ))}
        <text x={m.l + (width - m.l - m.r) / 2} y={H - 3} textAnchor="middle" style={{ ...TICK, fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Step
        </text>
      </svg>
    </div>
  );
}

function SmallHop({ effect, steps, width }: { effect: HopEffect; steps: number[]; width: number }) {
  const H = 150;
  const m = { l: 40, r: 6, t: 8, b: 20 };
  const rows = steps.filter((s) => effect.by_step[String(s)]).map((s) => ({ step: s, e: effect.by_step[String(s)] }));
  const overall = effect.overall;
  const vals: number[] = [0];
  for (const r of rows) {
    vals.push(r.e.estimate);
    if (r.e.ci) vals.push(r.e.ci[0], r.e.ci[1]);
  }
  if (overall) {
    vals.push(overall.estimate);
    if (overall.ci) vals.push(overall.ci[0], overall.ci[1]);
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.06;
  lo = lo < 0 ? lo - pad : lo;
  hi = hi > 0 ? hi + pad : hi;
  const ticks = niceTicks(lo, hi, 3);
  const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : hi - lo;
  const y = linear(lo, hi, H - m.b, m.t);
  const x = linear(0, Math.max(1, steps.length - 1), m.l + 8, width - m.r - 6);
  const excludes = overall?.ci ? overall.ci[0] > 0 || overall.ci[1] < 0 : false;
  const colour = !excludes ? tokens.text3 : (overall?.estimate ?? 0) < 0 ? scales.difference[0] : scales.difference[2];
  const label = `${hopLabel(effect.hop)}. ${plural(effect.agents, "agent")}. Overall effect ${fmt(overall?.estimate)}, interval ${fmtInterval(overall?.ci)}.`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-col">
        <span className="text-[13px] font-medium">{hopLabel(effect.hop)}</span>
        <span className="num text-[11px] text-text-3">n = {plural(effect.agents, "agent")}</span>
      </div>
      <svg width={width} height={H} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} />
            <text x={m.l - 5} y={y(t) + 3} textAnchor="end" style={TICK}>
              {fmtTick(t, tickStep)}
            </text>
          </g>
        ))}
        {overall && <line x1={m.l} x2={width - m.r} y1={y(overall.estimate)} y2={y(overall.estimate)} stroke={colour} strokeDasharray="3 3" />}
        {rows.map((r) => {
          const cx = x(steps.indexOf(r.step));
          return (
            <g key={r.step}>
              {r.e.ci && (
                <>
                  <line x1={cx} x2={cx} y1={y(r.e.ci[0])} y2={y(r.e.ci[1])} stroke={colour} />
                  <line x1={cx - 2.5} x2={cx + 2.5} y1={y(r.e.ci[0])} y2={y(r.e.ci[0])} stroke={colour} />
                  <line x1={cx - 2.5} x2={cx + 2.5} y1={y(r.e.ci[1])} y2={y(r.e.ci[1])} stroke={colour} />
                </>
              )}
              <circle cx={cx} cy={y(r.e.estimate)} r={2.4} fill={colour} />
            </g>
          );
        })}
        {[steps[0], steps[steps.length - 1]].map((s, i) =>
          s === undefined ? null : (
            <text key={i} x={x(steps.indexOf(s))} y={H - 6} textAnchor={i === 0 ? "start" : "end"} style={TICK}>
              {i === 0 ? `step ${s}` : s}
            </text>
          ),
        )}
      </svg>
      <span className="num text-[12px] text-text">{fmt(overall?.estimate)}</span>
      <span className="num text-[11px] text-text-3">{fmtInterval(overall?.ci)}</span>
    </div>
  );
}

/** One panel per hop, each with its own vertical scale, because a steered agent moves far more than its readers. */
export function HopEffects({ res }: { res: Pick<ForkResults, "hop_effects" | "steps"> }) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const count = Math.max(1, res.hop_effects.length);
  const gap = 12;
  const columns = width / count < 130 ? Math.max(1, Math.floor(width / 140)) : count;
  const panel = Math.floor((width - gap * (columns - 1)) / columns);
  return (
    <div ref={ref} className="w-full">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} data-testid="hop-chart">
        {res.hop_effects.map((h) => (
          <SmallHop key={h.hop} effect={h} steps={res.steps} width={panel} />
        ))}
      </div>
    </div>
  );
}

function outcomeColour(o: Outcome): string {
  if (!o.excludes_zero || !o.difference) return tokens.text3;
  return o.difference.estimate < 0 ? scales.difference[0] : scales.difference[2];
}

export function outcomeHasColour(o: Outcome): boolean {
  return o.excludes_zero && !!o.difference;
}

/** Interval dots on one shared axis, centred on zero. A filled dot means the interval excludes zero. */
export function OutcomeTable({ outcomes }: { outcomes: Outcome[] }) {
  const measured = outcomes.filter((o) => o.difference && !o.not_measured);
  const extent = Math.max(0, ...measured.flatMap((o) => [Math.abs(o.difference!.estimate), ...(o.difference!.ci ?? []).map(Math.abs)])) || 1;
  const pos = (v: number) => 50 + (v / extent) * 46;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-[13px]" data-testid="outcome-table">
        <thead>
          <tr className="text-left text-[12px] text-text-3">
            <th scope="col" className="pb-2 font-normal">Outcome</th>
            <th scope="col" className="pb-2 text-right font-normal">Control</th>
            <th scope="col" className="pb-2 text-right font-normal">Treatment</th>
            <th scope="col" className="pb-2 text-right font-normal">Difference</th>
            <th scope="col" className="pb-2 text-right font-normal">95% interval</th>
            <th scope="col" className="w-[230px] pb-2 pl-4 font-normal">
              <span className="num flex justify-between text-[10px] text-text-4">
                <span>{fmt(-extent)}</span>
                <span>0</span>
                <span>{fmt(extent)}</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => {
            if (o.not_measured || !o.difference) {
              return (
                <tr key={o.name} className="border-t border-divider">
                  <td className="py-2.5 pr-3 text-text-2">{o.label}</td>
                  <td colSpan={5} className="py-2.5 text-[12px] text-text-3">
                    Not measured. {o.not_measured}
                  </td>
                </tr>
              );
            }
            const colour = outcomeColour(o);
            const d = o.difference;
            return (
              <tr key={o.name} className="border-t border-divider" data-excludes-zero={o.excludes_zero}>
                <td className="py-2.5 pr-3 text-text-2">{o.label}</td>
                <td className="num py-2.5 text-right">{fmt(o.control)}</td>
                <td className="num py-2.5 text-right">{fmt(o.treatment)}</td>
                <td className="num py-2.5 text-right" style={{ color: colour }}>
                  {fmt(d.estimate)}
                </td>
                <td className="num py-2.5 text-right text-text-2">{fmtInterval(d.ci)}</td>
                <td className="py-2.5 pl-4">
                  <span className="relative block h-4" role="img" aria-label={`Difference ${fmt(d.estimate)}, interval ${fmtInterval(d.ci)}. ${o.excludes_zero ? "The interval excludes zero." : "The interval includes zero."}`}>
                    <span aria-hidden="true" className="absolute top-0 bottom-0 left-1/2 w-px bg-[#4A4D58]" />
                    {d.ci && <span aria-hidden="true" className="absolute top-[7px] h-0.5" style={{ left: `${pos(d.ci[0])}%`, width: `${Math.max(0.5, pos(d.ci[1]) - pos(d.ci[0]))}%`, background: colour }} />}
                    <span
                      aria-hidden="true"
                      className="absolute top-1 -ml-1 size-2 rounded-full"
                      style={{ left: `${pos(d.estimate)}%`, background: o.excludes_zero ? colour : tokens.surface, border: `1.5px solid ${colour}` }}
                    />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Concept activation over steps in both branches. Gaps stay gaps. */
export function TraceChart({ trace, firstDivergence, controlLabel = "Control", treatmentLabel = "Treatment", marker }: { trace: TracePoint[]; firstDivergence: number | null; controlLabel?: string; treatmentLabel?: string; marker?: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const H = 170;
  const m = { l: 46, r: 12, t: 10, b: 32 };
  const steps = trace.map((t) => t.step);
  const vals = trace.flatMap((t) => [t.control, t.treatment]).filter((v): v is number => v !== null && v !== undefined);
  if (!vals.length) return null;
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (lo === hi) hi = lo + 1;
  const ticks = niceTicks(lo, hi, 4);
  const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : hi - lo;
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = linear(steps[0], steps[steps.length - 1] === steps[0] ? steps[0] + 1 : steps[steps.length - 1], m.l + 6, width - m.r - 6);
  const y = linear(lo, hi, H - m.b, m.t);
  const path = (key: "control" | "treatment") => {
    let d = "";
    let last: number | null = null;
    for (const t of trace) {
      const v = t[key];
      if (v === null || v === undefined) {
        last = null;
        continue;
      }
      // A step with no reading breaks the line, so no value is implied there.
      const joined = last !== null && t.step === last + 1;
      d += `${joined ? "L" : "M"}${x(t.step).toFixed(1)} ${y(v).toFixed(1)}`;
      last = t.step;
    }
    return d;
  };
  return (
    <div ref={ref} className="w-full">
      <div className="flex flex-wrap items-center gap-4 pb-1 text-[12px] text-text-3">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: tokens.text3 }} />
          {controlLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-4 bg-accent" />
          {treatmentLabel}
        </span>
        {firstDivergence !== null && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-3 w-0 border-l border-dashed border-warn" />
            First divergence
          </span>
        )}
      </div>
      <svg width={width} height={H} role="img" aria-label={`Concept activation by step for ${controlLabel} and ${treatmentLabel}.`} data-testid="trace-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} />
            <text x={m.l - 6} y={y(t) + 3} textAnchor="end" style={TICK}>
              {fmtTick(t, tickStep)}
            </text>
          </g>
        ))}
        {firstDivergence !== null && steps.includes(firstDivergence) && <line x1={x(firstDivergence)} x2={x(firstDivergence)} y1={m.t} y2={H - m.b} stroke={tokens.warn} strokeDasharray="3 3" />}
        {marker !== null && marker !== undefined && steps.includes(marker) && <line x1={x(marker)} x2={x(marker)} y1={m.t} y2={H - m.b} stroke={tokens.text4} />}
        <path d={path("control")} fill="none" stroke={tokens.text3} strokeWidth={1.75} />
        <path d={path("treatment")} fill="none" stroke={tokens.accent} strokeWidth={1.75} />
        {trace.map((t) => (
          <g key={t.step}>
            {t.control !== null && t.control !== undefined && <circle cx={x(t.step)} cy={y(t.control)} r={2.5} fill={tokens.text3} />}
            {t.treatment !== null && t.treatment !== undefined && <circle cx={x(t.step)} cy={y(t.treatment)} r={2.5} fill={tokens.accent} />}
          </g>
        ))}
        {everyNth(steps, Math.floor(width / 34)).map((s) => (
          <text key={s} x={x(s)} y={H - m.b + 13} textAnchor="middle" style={TICK}>
            {s}
          </text>
        ))}
        <text x={m.l + (width - m.l - m.r) / 2} y={H - 3} textAnchor="middle" style={{ ...TICK, fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Step
        </text>
      </svg>
    </div>
  );
}

export function DensityChart({ counts, edges }: { counts: number[]; edges: number[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(340);
  const H = 130;
  const m = { l: 40, r: 6, t: 6, b: 30 };
  const peak = Math.max(1, ...counts);
  const ticks = niceTicks(0, peak, 3);
  const y = linear(0, peak, H - m.b, m.t);
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  const x = linear(lo, hi, m.l, width - m.r);
  const xt = niceTicks(lo, hi, 4);
  const xStep = xt.length > 1 ? xt[1] - xt[0] : hi - lo;
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={H} role="img" aria-label={`Histogram of activations from ${fmt(lo)} to ${fmt(hi)}.`} data-testid="density-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} />
            <text x={m.l - 5} y={y(t) + 3} textAnchor="end" style={TICK}>
              {t}
            </text>
          </g>
        ))}
        {counts.map((c, i) => {
          const x0 = x(edges[i]);
          const x1 = x(edges[i + 1]);
          return <rect key={i} x={x0 + 0.5} y={y(c)} width={Math.max(0.5, x1 - x0 - 1)} height={Math.max(c > 0 ? 1 : 0, y(0) - y(c))} fill={tokens.accent} opacity={0.85} rx={1} />;
        })}
        {xt.map((t) => (
          <text key={t} x={x(t)} y={H - m.b + 12} textAnchor="middle" style={TICK}>
            {fmtTick(t, xStep)}
          </text>
        ))}
        <text x={m.l + (width - m.l - m.r) / 2} y={H - 3} textAnchor="middle" style={{ ...TICK, fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Activation
        </text>
      </svg>
    </div>
  );
}

/** The mean activation across AI agents at each step. */
export function PerStepMean({ perStep, step, onPick }: { perStep: Record<string, number>; step: number | null; onPick: (s: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>(400);
  const H = 110;
  const m = { l: 42, r: 6, t: 6, b: 30 };
  const steps = Object.keys(perStep).map(Number).sort((a, b) => a - b);
  const vals = steps.map((s) => perStep[String(s)]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals) || 1;
  const ticks = niceTicks(lo, hi, 3);
  const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : hi - lo;
  const y = linear(Math.min(lo, ticks[0]), Math.max(hi, ticks[ticks.length - 1]), H - m.b, m.t);
  const band = (width - m.l - m.r) / Math.max(1, steps.length);
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={H} role="img" aria-label="Mean activation across AI agents at each step." data-testid="per-step-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} />
            <text x={m.l - 5} y={y(t) + 3} textAnchor="end" style={TICK}>
              {fmtTick(t, tickStep)}
            </text>
          </g>
        ))}
        {steps.map((s, i) => {
          const v = perStep[String(s)];
          const top = Math.min(y(v), y(0));
          const barH = Math.max(1, Math.abs(y(0) - y(v)));
          return (
            <g key={s} onClick={() => onPick(s)} style={{ cursor: "pointer" }}>
              <rect x={m.l + band * i} y={m.t} width={band} height={H - m.t - m.b} fill="transparent" />
              <rect x={m.l + band * i + band * 0.18} y={top} width={band * 0.64} height={barH} fill={s === step ? tokens.text : tokens.accent} rx={1} />
            </g>
          );
        })}
        {everyNth(steps, Math.floor(width / 30)).map((s) => (
          <text key={s} x={m.l + band * (steps.indexOf(s) + 0.5)} y={H - m.b + 12} textAnchor="middle" style={TICK}>
            {s}
          </text>
        ))}
        <text x={m.l + (width - m.l - m.r) / 2} y={H - 3} textAnchor="middle" style={{ ...TICK, fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Step
        </text>
      </svg>
    </div>
  );
}

export type { Estimate };
