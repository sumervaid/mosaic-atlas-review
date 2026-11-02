import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DivergenceFront, OutcomeTable } from "@/components/charts";
import { HealthGate } from "@/components/health";
import { MapLegend } from "@/components/swarm-map";
import { EmptyState, RecordedLabel, TEST_MODEL_TEXT, TestModelBanner } from "@/components/ui";
import { fmtInterval } from "@/lib/format";
import { scales } from "@/lib/tokens";
import type { ForkResults } from "@/lib/types";

const root = path.resolve(__dirname, "..");
const example = (name: string) => JSON.parse(readFileSync(path.join(root, "..", "docs", "api-examples", name), "utf8"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("data kind labels", () => {
  it("states the test model warning exactly", () => {
    render(<TestModelBanner />);
    expect(screen.getByRole("status").textContent).toBe("Test model. Random weights verify the software. This text and these numbers have no scientific meaning.");
    expect(TEST_MODEL_TEXT).toContain("no scientific meaning");
  });
  it("labels a recorded run quietly", () => {
    render(<RecordedLabel model="gemma-3-4b-it" />);
    expect(screen.getByTestId("recorded-label").textContent).toBe("Recorded run. Gemma 3 4B, read only.");
  });
});

describe("OutcomeTable, on a real API response", () => {
  const res = example("results_recorded_pilot.json") as ForkResults;

  it("prints each measured row's numbers rounded, with its interval", () => {
    render(<OutcomeTable outcomes={res.outcomes} />);
    const affect = res.outcomes.find((o) => o.name === "affect")!;
    const row = screen.getByText(affect.label).closest("tr")!;
    expect(row.textContent).toContain(affect.difference!.estimate.toFixed(2));
    expect(row.textContent).toContain(fmtInterval(affect.difference!.ci));
  });

  it("shows not_measured text and no value", () => {
    render(<OutcomeTable outcomes={res.outcomes} />);
    const gap = res.outcomes.find((o) => o.not_measured)!;
    const row = screen.getByText(gap.label).closest("tr")!;
    expect(row.textContent).toContain("Not measured.");
    expect(row.textContent).toContain(gap.not_measured);
    expect(row.textContent).not.toMatch(/\d\.\d\d/);
  });

  it("colours a difference only when its interval excludes zero", () => {
    const { container } = render(<OutcomeTable outcomes={res.outcomes} />);
    const rows = [...container.querySelectorAll("tr[data-excludes-zero]")];
    expect(rows.length).toBeGreaterThan(0);
    const scale = [scales.difference[0], scales.difference[2]].map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
    });
    for (const row of rows) {
      const colour = (row.children[3] as HTMLElement).style.color;
      if (row.getAttribute("data-excludes-zero") === "true") expect(scale).toContain(colour);
      else expect(scale).not.toContain(colour);
    }
  });
});

describe("DivergenceFront", () => {
  it("draws no noise bars when the noise floor is not measured", () => {
    const res = example("results_recorded_pilot.json") as ForkResults;
    expect(res.front.noise_floor).toBeNull();
    const { container } = render(<DivergenceFront res={res} />);
    expect(container.querySelectorAll("rect")).toHaveLength(res.steps.length);
  });
  it("draws paired bars when it is measured", () => {
    const res = example("results_live_256_trimmed.json") as ForkResults;
    const { container } = render(<DivergenceFront res={res} />);
    expect(container.querySelectorAll("rect")).toHaveLength(res.steps.length * 2);
  });
});

describe("map legend", () => {
  it("prints the colour range and always explains hollow agents", () => {
    render(<MapLegend domain={{ kind: "diverging", max: 40.96 }} roles={["Lead", "Member"]} valueLabel="Treatment minus control" />);
    const text = screen.getByTestId("map-legend").textContent;
    expect(text).toContain("-40.96");
    expect(text).toContain("+40.96");
    expect(text).toContain("No reading");
    expect(text).toContain("Member");
  });
});

describe("HealthGate", () => {
  it("replaces the screen with the start command when the API cannot be reached, and recovers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HealthGate>
        <EmptyState testid="child">Screen</EmptyState>
      </HealthGate>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("alert").textContent).toContain("./scripts/run.sh");
    expect(screen.getByTestId("child").closest("[hidden]")).not.toBeNull();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, gpu: false, gpu_count: 0, loaded_models: [] }), { status: 200 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("child").closest("[hidden]")).toBeNull();
  });
  it("does not call one slow answer an outage", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("timeout")).mockResolvedValue(new Response(JSON.stringify({ ok: true, gpu: false, gpu_count: 0, loaded_models: [] }), { status: 200 })));
    render(
      <HealthGate>
        <span>Screen</span>
      </HealthGate>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

describe("interface source", () => {
  const files = ["app", "components", "lib"].flatMap((d) => sourceFiles(path.join(root, d)));
  const all = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));

  it("holds no em dashes", () => {
    for (const { f, text } of all) expect(`${f}: ${text.includes("\u2014")}`).toBe(`${f}: false`);
  });
  it("holds none of the design prototypes' placeholder content", () => {
    for (const { f, text } of all) {
      for (const word of ["Plan to defer", "Doubt about a claim", "hierarchy-pilot", "Sample data", "New auto-interp", "Math.random"]) {
        expect(`${f}: ${word}: ${text.includes(word)}`).toBe(`${f}: ${word}: false`);
      }
    }
  });
  it("never offers a text area for a key or a token on Setup", () => {
    const setup = readFileSync(path.join(root, "components", "setup-screen.tsx"), "utf8");
    expect(setup).not.toContain("<textarea");
    expect(setup).not.toContain('type="file"');
  });
});
