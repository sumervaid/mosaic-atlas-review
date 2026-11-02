// Swarm map geometry and the values it colours. Pure functions, so they can be tested without a canvas.
import { activationColor, differenceColor } from "./color";
import type { Agent, ForkResults } from "./types";

export type ColorBy = "control" | "treatment" | "difference";

export interface Placed {
  id: string;
  x: number;
  y: number;
  r: number;
  role: string;
  team: number;
}

export interface TeamLabel {
  x: number;
  y: number;
  text: string;
}

export interface SwarmLayout {
  nodes: Placed[];
  teamLabels: TeamLabel[];
  showNames: boolean;
}

const isCoordinator = (a: Agent) => a.role === "Coordinator" || a.team === 0;

/** Agents grouped by team, coordinators first, each team's lead first within the team. */
export function orderAgents(agents: Agent[]): Agent[] {
  const rank = (a: Agent) => (isCoordinator(a) ? 0 : a.role === "Lead" ? 1 : 2);
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.team - y.a.team || rank(x.a) - rank(y.a) || x.i - y.i)
    .map(({ a }) => a);
}

export function teamsOf(agents: Agent[]): number[] {
  return [...new Set(agents.filter((a) => !isCoordinator(a)).map((a) => a.team))].sort((a, b) => a - b);
}

/** Angles that space points equally along an ellipse's edge, starting at the top. Equal angles would bunch at the sides. */
function evenAnglesOnEllipse(rx: number, ry: number, count: number): number[] {
  const samples = 1440;
  const lengths = [0];
  const at = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / samples;
  for (let i = 1; i <= samples; i++) {
    const seg = Math.hypot(rx * (Math.cos(at(i)) - Math.cos(at(i - 1))), ry * (Math.sin(at(i)) - Math.sin(at(i - 1))));
    lengths.push(lengths[i - 1] + seg);
  }
  const total = lengths[samples];
  const out: number[] = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const want = (total * k) / count;
    while (lengths[i] < want) i += 1;
    out.push(at(i));
  }
  return out;
}

export function layoutSwarm(agents: Agent[], width: number, height: number): SwarmLayout {
  const ordered = orderAgents(agents);
  const coords = ordered.filter(isCoordinator);
  const teams = teamsOf(ordered);
  const cx = width / 2;
  const cy = height / 2;
  const nodes: Placed[] = [];
  const teamLabels: TeamLabel[] = [];
  const place = (a: Agent, x: number, y: number, r: number) =>
    nodes.push({ id: a.id, x, y, r, role: a.role, team: a.team });

  if (teams.length <= 1) {
    // One team. Lead at the centre, everyone else on rings that fill the card.
    const members = ordered.filter((a) => !isCoordinator(a) && a.role !== "Lead");
    const centre = ordered.filter((a) => isCoordinator(a) || a.role === "Lead");
    const showNames = ordered.length <= 64;
    const pad = showNames ? 30 : 16;
    const radiusY = height / 2 - pad;
    const radiusX = Math.min(width / 2 - pad - 24, radiusY * 2.3);
    let rings = 1;
    while ((6 * rings * (rings + 1)) / 2 < members.length) rings += 1;
    const weight = (rings * (rings + 1)) / 2;
    const counts = Array.from({ length: rings }, (_, k) => Math.floor((members.length * (k + 1)) / weight));
    counts[rings - 1] += members.length - counts.reduce((a, b) => a + b, 0);
    // The first ring sits out from the centre, so the lead and its label stay clear of it.
    const inner = 0.34;
    const ringGap = (radiusY * (1 - inner)) / Math.max(1, rings - 1 || 1);
    const dot = Math.max(5, Math.min(13, ringGap * 0.2));
    centre.forEach((a, i) => place(a, cx + (i - (centre.length - 1) / 2) * dot * 4, cy, dot * 1.35));
    let used = 0;
    counts.forEach((count, k) => {
      const frac = rings === 1 ? 0.7 : inner + ((1 - inner) * k) / (rings - 1);
      for (let j = 0; j < count; j++) {
        const angle = -Math.PI / 2 + ((j + (k % 2 ? 0.5 : 0)) * 2 * Math.PI) / Math.max(1, count);
        place(members[used + j], cx + radiusX * frac * Math.cos(angle), cy + radiusY * frac * Math.sin(angle), dot);
      }
      used += count;
    });
    return { nodes, teamLabels, showNames };
  }

  // Several teams on an ellipse around the coordinator, as in the design.
  const biggest = Math.max(...teams.map((t) => ordered.filter((a) => a.team === t).length));
  // Ramanujan's ellipse perimeter gives each team a fair share of the ring.
  const a = Math.max(40, width / 2 - 70);
  const b = Math.max(40, height / 2 - 70);
  const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const clusterR = Math.max(14, Math.min(height * 0.11, (perimeter / teams.length) * 0.31));
  const dot = Math.max(2.5, Math.min(7, ((2 * Math.PI * clusterR) / Math.max(1, biggest - 1)) * 0.33));
  const rx = Math.max(10, width / 2 - clusterR - dot - 34);
  const ry = Math.max(10, height / 2 - clusterR - dot - 26);
  coords.forEach((a, i) => place(a, cx + (i - (coords.length - 1) / 2) * dot * 5, cy, dot * 2));
  const angles = evenAnglesOnEllipse(rx, ry, teams.length);
  teams.forEach((team, k) => {
    const angle = angles[k];
    const tx = cx + rx * Math.cos(angle);
    const ty = cy + ry * Math.sin(angle);
    const inTeam = ordered.filter((a) => a.team === team);
    const lead = inTeam.filter((a) => a.role === "Lead");
    const rest = inTeam.filter((a) => a.role !== "Lead");
    lead.forEach((a) => place(a, tx, ty, dot * 1.5));
    rest.forEach((a, j) => {
      const b = (2 * Math.PI * j) / rest.length;
      place(a, tx + clusterR * Math.cos(b), ty + clusterR * Math.sin(b), dot);
    });
    const out = clusterR + dot + 11;
    teamLabels.push({ x: tx + out * Math.cos(angle) * 1.05, y: ty + out * Math.sin(angle), text: `T${team}` });
  });
  return { nodes, teamLabels, showNames: false };
}

export function hitTest(nodes: Placed[], x: number, y: number, slack = 4): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slack && d < bestDist) {
      best = n.id;
      bestDist = d;
    }
  }
  return best;
}

/** Keyboard movement. The nearest node in the pressed direction, favouring nodes straight ahead. */
export function nearestInDirection(nodes: Placed[], fromId: string, dir: "left" | "right" | "up" | "down"): string {
  const from = nodes.find((n) => n.id === fromId);
  if (!from) return nodes[0]?.id ?? fromId;
  const [ux, uy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n.id === from.id) continue;
    const dx = n.x - from.x;
    const dy = n.y - from.y;
    const ahead = dx * ux + dy * uy;
    if (ahead <= 0.5) continue;
    const side = Math.abs(dx * uy - dy * ux);
    const score = ahead + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best ?? from.id;
}

/** Values at one step. An agent with no reading at that step is absent, never zero. */
export function valuesAtStep(res: Pick<ForkResults, "map">, by: ColorBy, step: number): Record<string, number> {
  const key = String(step);
  const c = res.map.control[key] ?? {};
  const t = res.map.treatment[key] ?? {};
  if (by === "control") return { ...c };
  if (by === "treatment") return { ...t };
  const out: Record<string, number> = {};
  for (const id of Object.keys(t)) {
    if (id in c) out[id] = t[id] - c[id];
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export type ColorDomain = { kind: "sequential"; lo: number; hi: number } | { kind: "diverging"; max: number };

/**
 * The colour range for a map. A steered agent can read twenty times higher than everyone else, so the range comes
 * from agents that were not intervened on. A floor at 5% of the overall size stops rounding noise from filling the
 * scale. The legend prints the range, so nothing is hidden.
 */
export function colorDomain(res: Pick<ForkResults, "map" | "steps" | "targets">, by: ColorBy): ColorDomain {
  const targets = new Set(res.targets);
  if (by === "difference") {
    const others: number[] = [];
    let overall = 0;
    for (const s of Object.keys(res.map.treatment)) {
      const v = valuesAtStep(res, "difference", Number(s));
      for (const [id, x] of Object.entries(v)) {
        overall = Math.max(overall, Math.abs(x));
        if (!targets.has(id)) others.push(Math.abs(x));
      }
    }
    others.sort((a, b) => a - b);
    const robust = quantile(others, 0.95);
    return { kind: "diverging", max: Math.max(robust, overall * 0.05) || 1 };
  }
  const others: number[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of [res.map.control, res.map.treatment]) {
    for (const row of Object.values(m)) {
      for (const [id, x] of Object.entries(row)) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
        if (!targets.has(id)) others.push(x);
      }
    }
  }
  if (!Number.isFinite(lo)) return { kind: "sequential", lo: 0, hi: 1 };
  others.sort((a, b) => a - b);
  const rLo = others.length ? quantile(others, 0.02) : lo;
  let rHi = others.length ? quantile(others, 0.98) : hi;
  if (rHi - rLo < (hi - lo) * 0.05) rHi = rLo + (hi - lo) * 0.05;
  if (rHi <= rLo) rHi = rLo + 1;
  return { kind: "sequential", lo: rLo, hi: rHi };
}

export function colorFor(domain: ColorDomain, value: number): string {
  if (domain.kind === "diverging") return differenceColor(value / domain.max);
  return activationColor((value - domain.lo) / (domain.hi - domain.lo));
}

/** First step on the axis holding any reading. */
export function firstStepWithData(res: Pick<ForkResults, "map" | "steps">): number | null {
  for (const s of res.steps) {
    if (Object.keys(res.map.treatment[String(s)] ?? {}).length || Object.keys(res.map.control[String(s)] ?? {}).length) return s;
  }
  return null;
}
