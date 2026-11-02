"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWidth } from "@/lib/api";
import { fmt } from "@/lib/format";
import { orderAgents } from "@/lib/swarm";
import { MONO_FONT, scales, tokens } from "@/lib/tokens";
import type { Agent, ContagionEdge, ContagionNode } from "@/lib/types";

const PAD = { left: 146, right: 28, top: 28, bottom: 12 };

export interface GraphGeometry {
  rowH: number;
  height: number;
  stepX: (step: number) => number;
  rowY: (agent: string) => number | undefined;
  steps: number[];
  rows: Agent[];
}

export function graphGeometry(rows: Agent[], steps: number[], width: number, targetHeight: number): GraphGeometry {
  const rowH = Math.max(8, Math.floor((targetHeight - PAD.top - PAD.bottom) / Math.max(1, rows.length)));
  const height = Math.max(160, rowH * rows.length + PAD.top + PAD.bottom);
  const span = width - PAD.left - PAD.right;
  const pos = new Map(rows.map((a, i) => [a.id, PAD.top + rowH * (i + 0.5)]));
  const at = new Map(steps.map((s, i) => [s, PAD.left + (steps.length > 1 ? (span * i) / (steps.length - 1) : span / 2)]));
  return { rowH, height, stepX: (s) => at.get(s) ?? PAD.left, rowY: (a) => pos.get(a), steps, rows };
}

export function LinkGraph({ agents, nodes, edges, selected, onSelect, targetHeight = 600 }: { agents: Agent[]; nodes: ContagionNode[]; edges: ContagionEdge[]; selected: string | null; onSelect: (id: string) => void; targetHeight?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const rows = useMemo(() => orderAgents(agents), [agents]);
  const visible = useMemo(() => {
    const ids = new Set(rows.map((a) => a.id));
    return nodes.filter((n) => ids.has(n.agent));
  }, [rows, nodes]);
  const steps = useMemo(() => [...new Set(nodes.map((n) => n.step))].sort((a, b) => a - b), [nodes]);
  const geo = useMemo(() => graphGeometry(rows, steps, width, targetHeight), [rows, steps, width, targetHeight]);
  const dotR = Math.max(2.5, Math.min(7, geo.rowH * 0.3));
  const byCell = useMemo(() => new Map(visible.map((n) => [`${n.agent}|${n.step}`, n])), [visible]);
  const touched = useMemo(() => new Set(edges.flatMap((e) => [e.message_id, `${e.to}|${e.step + 1}`])), [edges]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(width * dpr);
      c.height = Math.round(geo.height * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, geo.height);
      ctx.font = `11px ${MONO_FONT}`;
      ctx.textBaseline = "middle";

      ctx.textAlign = "center";
      ctx.fillStyle = tokens.text4;
      for (const s of steps) ctx.fillText(`step ${s}`, geo.stepX(s), 12);

      const labelEvery = geo.rowH >= 11 ? 1 : Math.ceil(11 / geo.rowH);
      rows.forEach((a, i) => {
        const y = geo.rowY(a.id) as number;
        ctx.strokeStyle = tokens.divider;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.left - 12, y);
        ctx.lineTo(width - PAD.right + 8, y);
        ctx.stroke();
        if (i % labelEvery === 0) {
          ctx.textAlign = "left";
          ctx.font = `${geo.rowH >= 18 ? 12 : 10}px ${MONO_FONT}`;
          ctx.fillStyle = tokens.text2;
          ctx.fillText(a.id, 0, geo.rowH >= 40 ? y - 7 : y);
          if (geo.rowH >= 40) {
            ctx.fillStyle = tokens.text4;
            ctx.font = `11px ${MONO_FONT}`;
            ctx.fillText(a.role, 0, y + 8);
          } else if (geo.rowH >= 14) {
            ctx.fillStyle = tokens.text4;
            ctx.font = `11px ${MONO_FONT}`;
            ctx.fillText(a.role, 58, y);
          }
        }
      });

      const peak = Math.max(1e-12, ...edges.map((e) => Math.abs(e.weight)));
      for (const e of edges) {
        const y0 = geo.rowY(e.from);
        const y1 = geo.rowY(e.to);
        if (y0 === undefined || y1 === undefined) continue;
        const x0 = geo.stepX(e.step);
        const x1 = geo.stepX(e.step + 1);
        const colour = e.weight < 0 ? scales.difference[0] : scales.difference[2];
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5 + (Math.abs(e.weight) / peak) * 3;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x1, y1);
        ctx.stroke();
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const label = fmt(e.weight);
        ctx.font = `12px ${MONO_FONT}`;
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = tokens.surface;
        ctx.fillRect(mx - w / 2, my - 9, w, 18);
        ctx.fillStyle = colour;
        ctx.textAlign = "center";
        ctx.fillText(label, mx, my);
      }

      for (const n of visible) {
        const y = geo.rowY(n.agent);
        if (y === undefined) continue;
        const x = geo.stepX(n.step);
        const measured = touched.has(n.id) || touched.has(`${n.agent}|${n.step}`);
        ctx.beginPath();
        ctx.arc(x, y, measured ? dotR + 1.5 : dotR, 0, Math.PI * 2);
        ctx.fillStyle = measured ? tokens.accentText : "#4A4D58";
        ctx.fill();
        if (n.id === selected) {
          ctx.beginPath();
          ctx.arc(x, y, dotR + 4, 0, Math.PI * 2);
          ctx.strokeStyle = tokens.warn;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (n.id === hover) {
          ctx.beginPath();
          ctx.arc(x, y, dotR + 2, 0, Math.PI * 2);
          ctx.strokeStyle = tokens.text;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (focused && n.id === focusId) {
          ctx.beginPath();
          ctx.arc(x, y, dotR + 7, 0, Math.PI * 2);
          ctx.strokeStyle = tokens.accentText;
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    };
    draw();
    void document.fonts?.ready.then(draw);
  }, [width, geo, rows, steps, edges, visible, selected, hover, focusId, focused, dotR, touched]);

  const nodeAt = (px: number, py: number): ContagionNode | null => {
    let best: ContagionNode | null = null;
    let bestD = Math.max(9, dotR + 5);
    for (const n of visible) {
      const y = geo.rowY(n.agent);
      if (y === undefined) continue;
      const d = Math.hypot(geo.stepX(n.step) - px, y - py);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  const move = (dx: number, dy: number) => {
    const cur = visible.find((n) => n.id === focusId) ?? visible[0];
    if (!cur) return;
    if (dx) {
      let i = steps.indexOf(cur.step) + dx;
      while (i >= 0 && i < steps.length) {
        const n = byCell.get(`${cur.agent}|${steps[i]}`);
        if (n) return setFocusId(n.id);
        i += dx;
      }
    } else {
      let i = rows.findIndex((a) => a.id === cur.agent) + dy;
      while (i >= 0 && i < rows.length) {
        const n = byCell.get(`${rows[i].id}|${cur.step}`);
        if (n) return setFocusId(n.id);
        i += dy;
      }
    }
  };

  const active = visible.find((n) => n.id === (hover ?? (focused ? focusId : null)));
  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className="max-h-[640px] w-full overflow-y-auto">
        <canvas
          ref={canvas}
          data-testid="link-canvas"
          data-nodes={visible.length}
          data-edges={edges.length}
          tabIndex={0}
          role="application"
          aria-label={`Link graph. Rows are agents and columns are steps. ${visible.length} messages. Use arrow keys to move between messages. Press Enter to choose one.`}
          style={{ width, height: geo.height, display: "block", cursor: hover ? "pointer" : "default" }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(nodeAt(e.clientX - r.left, e.clientY - r.top)?.id ?? null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
            if (n) {
              setFocusId(n.id);
              onSelect(n.id);
            }
          }}
          onFocus={() => {
            setFocused(true);
            setFocusId((f) => f ?? selected ?? visible[0]?.id ?? null);
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); move(-1, 0); }
            else if (e.key === "ArrowRight") { e.preventDefault(); move(1, 0); }
            else if (e.key === "ArrowUp") { e.preventDefault(); move(0, -1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); move(0, 1); }
            else if ((e.key === "Enter" || e.key === " ") && focusId) { e.preventDefault(); onSelect(focusId); }
          }}
        />
      </div>
      <p className="num m-0 min-h-[18px] text-[12px] text-text-2" aria-live="polite">
        {active ? `${active.agent}, step ${active.step}. Message ${active.id}.` : "Hover over a message, or focus the graph and use the arrow keys."}
      </p>
    </div>
  );
}
