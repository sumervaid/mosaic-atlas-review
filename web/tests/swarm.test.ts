import { describe, expect, it } from "vitest";
import { colorDomain, firstStepWithData, hitTest, layoutSwarm, nearestInDirection, orderAgents, teamsOf, valuesAtStep } from "@/lib/swarm";
import type { Agent, ForkResults } from "@/lib/types";

function population(teams: number, perTeam: number): Agent[] {
  const out: Agent[] = [{ id: "A000", role: "Coordinator", team: 0 }];
  let n = 1;
  for (let t = 1; t <= teams; t++) {
    out.push({ id: `A${String(n++).padStart(3, "0")}`, role: "Lead", team: t });
    for (let m = 0; m < perTeam; m++) out.push({ id: `A${String(n++).padStart(3, "0")}`, role: m < 10 ? "Prover" : "Verifier", team: t });
  }
  return out;
}

const single: Agent[] = [{ id: "Lee", role: "Lead", team: 1 }, ...Array.from({ length: 49 }, (_, i) => ({ id: `M${i}`, role: "Member", team: 1 }))];

describe("layoutSwarm", () => {
  it("places all 256 agents inside the canvas", () => {
    const agents = population(15, 16);
    expect(agents).toHaveLength(256);
    const { nodes, teamLabels } = layoutSwarm(agents, 980, 620);
    expect(nodes).toHaveLength(256);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(256);
    expect(teamLabels).toHaveLength(15);
    for (const n of nodes) {
      expect(n.x - n.r).toBeGreaterThanOrEqual(0);
      expect(n.x + n.r).toBeLessThanOrEqual(980);
      expect(n.y - n.r).toBeGreaterThanOrEqual(0);
      expect(n.y + n.r).toBeLessThanOrEqual(620);
    }
    for (const t of teamLabels) {
      expect(t.y).toBeGreaterThanOrEqual(5);
      expect(t.y).toBeLessThanOrEqual(615);
    }
  });
  it("keeps agents apart in the 256 layout, so each can be clicked", () => {
    const { nodes } = layoutSwarm(population(15, 16), 980, 620);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)).toBeGreaterThan(nodes[i].r);
      }
    }
  });
  it("keeps teams from running into each other", () => {
    const agents = population(15, 16);
    for (const [w, h] of [[980, 620], [760, 500]]) {
      const { nodes } = layoutSwarm(agents, w, h);
      const team = new Map(agents.map((a) => [a.id, a.team]));
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (team.get(nodes[i].id) === team.get(nodes[j].id) || nodes[i].team === 0 || nodes[j].team === 0) continue;
          expect(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)).toBeGreaterThan(nodes[i].r + nodes[j].r);
        }
      }
    }
  });
  it("puts a lone team's lead at the centre and names agents", () => {
    const { nodes, showNames } = layoutSwarm(single, 900, 440);
    expect(showNames).toBe(true);
    expect(nodes).toHaveLength(50);
    const lead = nodes.find((n) => n.id === "Lee");
    expect(lead?.x).toBe(450);
    expect(lead?.y).toBe(220);
    for (const n of nodes) {
      expect(n.y + n.r + 14).toBeLessThanOrEqual(440);
      if (n.id !== "Lee") expect(Math.hypot(n.x - 450, n.y - 220)).toBeGreaterThan(50);
    }
  });
  it("handles the six agent pilot", () => {
    const { nodes } = layoutSwarm(single.slice(0, 6), 900, 440);
    expect(nodes).toHaveLength(6);
  });
  it("orders the coordinator first and each lead before its team", () => {
    const ordered = orderAgents(population(2, 2));
    expect(ordered.map((a) => a.role).slice(0, 2)).toEqual(["Coordinator", "Lead"]);
    expect(teamsOf(ordered)).toEqual([1, 2]);
  });
});

describe("hit testing and keyboard movement", () => {
  const nodes = [
    { id: "a", x: 100, y: 100, r: 5, role: "Lead", team: 1 },
    { id: "b", x: 200, y: 100, r: 5, role: "Prover", team: 1 },
    { id: "c", x: 100, y: 200, r: 5, role: "Prover", team: 1 },
  ];
  it("finds the nearest node within reach and nothing outside it", () => {
    expect(hitTest(nodes, 102, 101)).toBe("a");
    expect(hitTest(nodes, 150, 150)).toBeNull();
  });
  it("moves in the pressed direction and stays put at an edge", () => {
    expect(nearestInDirection(nodes, "a", "right")).toBe("b");
    expect(nearestInDirection(nodes, "a", "down")).toBe("c");
    expect(nearestInDirection(nodes, "a", "left")).toBe("a");
    expect(nearestInDirection(nodes, "missing", "left")).toBe("a");
  });
});

function results(partial: Partial<ForkResults>): Pick<ForkResults, "map" | "steps" | "targets"> {
  return { map: { control: {}, treatment: {} }, steps: [1, 2], targets: [], ...partial };
}

describe("map values", () => {
  const res = results({
    map: {
      control: { "1": { a: 1, b: 2 }, "2": { a: 1 } },
      treatment: { "1": { a: 4, b: 2 }, "2": { b: 5 } },
    },
  });
  it("leaves out agents with no reading instead of writing zero", () => {
    expect(valuesAtStep(res, "control", 2)).toEqual({ a: 1 });
    expect(valuesAtStep(res, "treatment", 2)).toEqual({ b: 5 });
    expect(valuesAtStep(res, "control", 9)).toEqual({});
  });
  it("computes a difference only where both branches have a reading", () => {
    expect(valuesAtStep(res, "difference", 1)).toEqual({ a: 3, b: 0 });
    expect(valuesAtStep(res, "difference", 2)).toEqual({});
  });
  it("finds the first step with data", () => {
    expect(firstStepWithData(res)).toBe(1);
    expect(firstStepWithData(results({ steps: [1] }))).toBeNull();
  });
});

describe("colorDomain", () => {
  it("takes the difference range from agents that were not intervened on", () => {
    const control: Record<string, number> = {};
    const treatment: Record<string, number> = { lead: 400 };
    control.lead = 0;
    for (let i = 0; i < 50; i++) {
      control[`m${i}`] = 0;
      treatment[`m${i}`] = 30;
    }
    const d = colorDomain(results({ map: { control: { "1": control }, treatment: { "1": treatment } }, targets: ["lead"] }), "difference");
    expect(d).toEqual({ kind: "diverging", max: 30 });
  });
  it("does not let rounding noise fill the scale", () => {
    const d = colorDomain(results({ map: { control: { "1": { lead: 0, m: 0 } }, treatment: { "1": { lead: 4, m: 1e-9 } } }, targets: ["lead"] }), "difference");
    expect(d).toEqual({ kind: "diverging", max: 0.2 });
  });
  it("shares one sequential range across both branches", () => {
    const res = results({ map: { control: { "1": { a: 0 } }, treatment: { "1": { a: 10 } } } });
    const c = colorDomain(res, "control");
    expect(c).toEqual(colorDomain(res, "treatment"));
    expect(c.kind).toBe("sequential");
  });
  it("survives an empty map", () => {
    expect(colorDomain(results({}), "control")).toEqual({ kind: "sequential", lo: 0, hi: 1 });
    expect(colorDomain(results({}), "difference").kind).toBe("diverging");
  });
});
