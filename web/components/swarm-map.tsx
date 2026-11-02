"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWidth } from "@/lib/api";
import { differenceGradient, activationGradient } from "@/lib/color";
import { fmt, plural } from "@/lib/format";
import { type ColorDomain, colorFor, hitTest, layoutSwarm, nearestInDirection, type Placed } from "@/lib/swarm";
import { MONO_FONT, tokens } from "@/lib/tokens";
import type { Agent } from "@/lib/types";

export interface SwarmMapProps {
  agents: Agent[];
  edges?: Record<string, string[]>;
  values: Record<string, number>;
  domain: ColorDomain | null;
  targets?: Set<string>;
  selected?: Set<string>;
  inspected?: string | null;
  height?: number;
  label: string;
  /** Text describing what an activation does here. */
  actionHint?: string;
  valueLabel?: string;
  onActivate?: (id: string) => void;
  readoutExtra?: (id: string) => string;
}

function roleShape(ctx: CanvasRenderingContext2D, role: string, x: number, y: number, r: number) {
  ctx.beginPath();
  if (role === "Coordinator") {
    ctx.moveTo(x, y - r * 1.15);
    ctx.lineTo(x + r * 1.15, y);
    ctx.lineTo(x, y + r * 1.15);
    ctx.lineTo(x - r * 1.15, y);
    ctx.closePath();
  } else if (role === "Verifier") {
    const s = r * 0.88;
    ctx.rect(x - s, y - s, s * 2, s * 2);
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function drawSwarm(canvas: HTMLCanvasElement, width: number, height: number, nodes: Placed[], layout: ReturnType<typeof layoutSwarm>, props: SwarmMapProps, focusId: string | null, hoverId: string | null, focused: boolean) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Ties that exist in the message graph, drawn only where they show the hierarchy.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  ctx.strokeStyle = "#262830";
  ctx.lineWidth = 1;
  for (const n of nodes) {
    if (n.role !== "Lead" && n.role !== "Coordinator") continue;
    for (const other of props.edges?.[n.id] ?? []) {
      const m = byId.get(other);
      if (!m) continue;
      const showsHierarchy = (n.role === "Coordinator" && m.role === "Lead") || (n.role === "Lead" && m.team === n.team && m.role !== "Coordinator" && m.role !== "Lead");
      if (!showsHierarchy) continue;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
    }
  }

  ctx.font = `10px ${MONO_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.text4;
  for (const t of layout.teamLabels) ctx.fillText(t.text, t.x, t.y);

  let filled = 0;
  for (const n of nodes) {
    const v = props.values[n.id];
    const has = v !== undefined && v !== null && props.domain !== null;
    roleShape(ctx, n.role, n.x, n.y, n.r);
    if (has) {
      ctx.fillStyle = colorFor(props.domain as ColorDomain, v);
      ctx.fill();
      ctx.strokeStyle = "#3A3D46";
      ctx.lineWidth = 1;
      ctx.stroke();
      filled += 1;
    } else {
      // No reading at this step. Hollow, so an absent value never reads as zero.
      ctx.strokeStyle = "#6E727C";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (props.targets?.has(n.id)) {
      roleShape(ctx, n.role, n.x, n.y, n.r + 2.5);
      ctx.strokeStyle = tokens.warn;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (props.selected?.has(n.id)) {
      roleShape(ctx, n.role, n.x, n.y, n.r + (props.targets?.has(n.id) ? 5 : 2.5));
      ctx.strokeStyle = tokens.text;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (props.inspected === n.id) {
      roleShape(ctx, n.role, n.x, n.y, n.r + 6);
      ctx.strokeStyle = tokens.accentText;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (hoverId === n.id) {
      roleShape(ctx, n.role, n.x, n.y, n.r + 1.5);
      ctx.strokeStyle = tokens.text2;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (focused && focusId === n.id) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2);
      ctx.strokeStyle = tokens.accentText;
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (layout.showNames) {
      ctx.fillStyle = props.targets?.has(n.id) ? tokens.warnText : tokens.text2;
      const ringed = props.targets?.has(n.id) || props.selected?.has(n.id) || props.inspected === n.id;
      ctx.fillText(n.id, n.x, n.y + n.r + (ringed ? 17 : 10));
    }
  }
  return filled;
}

export function SwarmMap(props: SwarmMapProps) {
  const { agents, height = 460 } = props;
  const [ref, width] = useWidth<HTMLDivElement>(800);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const layout = useMemo(() => layoutSwarm(agents, width, height), [agents, width, height]);
  const nodes = layout.nodes;
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const redraw = () => setFilled(drawSwarm(c, width, height, nodes, layout, props, focusId, hover, focused));
    redraw();
    // Canvas text falls back until Geist Mono has loaded.
    void document.fonts?.ready.then(redraw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, layout, props.values, props.domain, props.targets, props.selected, props.inspected, props.edges, focusId, hover, focused]);

  const pos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const activeId = hover ?? (focused ? focusId : null) ?? props.inspected ?? null;
  const active = activeId ? agents.find((a) => a.id === activeId) : undefined;
  const readout = active
    ? `${active.id}. ${active.role}${active.team ? `, team ${active.team}` : ""}. ${props.values[active.id] === undefined ? "No reading at this step." : `${props.valueLabel ?? "Value"} ${fmt(props.values[active.id])}.`}${props.readoutExtra ? ` ${props.readoutExtra(active.id)}` : ""}`
    : (props.actionHint ?? "Hover over an agent, or focus the map and use the arrow keys.");

  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className="w-full">
        <canvas
          ref={canvasRef}
          data-testid="swarm-canvas"
          data-agents={nodes.length}
          data-filled={filled}
          data-hover={hover ?? ""}
          tabIndex={0}
          role="application"
          aria-label={`${props.label}. ${plural(nodes.length, "agent")}. Use arrow keys to move between agents. Press Enter to choose one.`}
          style={{ width, height, display: "block", cursor: hover && props.onActivate ? "pointer" : "default" }}
          onMouseMove={(e) => {
            const p = pos(e);
            setHover(hitTest(nodes, p.x, p.y));
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const p = pos(e);
            const id = hitTest(nodes, p.x, p.y);
            if (id) {
              setFocusId(id);
              props.onActivate?.(id);
            }
          }}
          onFocus={() => {
            setFocused(true);
            setFocusId((f) => f ?? props.inspected ?? nodes[0]?.id ?? null);
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            const dir = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[e.key as "ArrowLeft"];
            if (dir && focusId) {
              e.preventDefault();
              setFocusId(nearestInDirection(nodes, focusId, dir));
            } else if ((e.key === "Enter" || e.key === " ") && focusId) {
              e.preventDefault();
              props.onActivate?.(focusId);
            }
          }}
        />
      </div>
      <p className="num m-0 min-h-[18px] text-[12px] text-text-2" aria-live="polite" data-testid="map-readout">
        {readout}
      </p>
    </div>
  );
}

function ShapeKey({ role }: { role: string }) {
  const shape = role === "Coordinator" ? <path d="M6 0.8 L11.2 6 L6 11.2 L0.8 6 Z" /> : role === "Verifier" ? <rect x="2" y="2" width="8" height="8" /> : <circle cx="6" cy="6" r={role === "Lead" ? 5 : 3.8} />;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke={tokens.text3} strokeWidth="1.25">
      {shape}
    </svg>
  );
}

export function MapLegend({ domain, roles, showTargets = true, valueLabel, note }: { domain: ColorDomain | null; roles: string[]; showTargets?: boolean; valueLabel: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-text-3" data-testid="map-legend">
      {domain && (
        <span className="flex items-center gap-2">
          <span className="num text-[11px]">{domain.kind === "diverging" ? fmt(-domain.max) : fmt(domain.lo)}</span>
          <span aria-hidden="true" className="h-2 w-24 rounded" style={{ background: domain.kind === "diverging" ? differenceGradient : activationGradient }} />
          <span className="num text-[11px]">{domain.kind === "diverging" ? `+${fmt(domain.max)}` : fmt(domain.hi)}</span>
          <span>{valueLabel}</span>
        </span>
      )}
      {roles.map((r) => (
        <span key={r} className="flex items-center gap-1.5">
          <ShapeKey role={r} />
          {r}
        </span>
      ))}
      {showTargets && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-[9px] rounded-full shadow-[0_0_0_2px_var(--color-warn)]" />
          Intervened
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-[9px] rounded-full border border-dashed border-[#6E727C]" />
        No reading
      </span>
      {note && <span className="w-full">{note}</span>}
    </div>
  );
}
