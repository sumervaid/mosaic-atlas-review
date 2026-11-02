import { describe, expect, it } from "vitest";
import { fmt, fmtInterval, fmtPercent, fmtSigned, hopLabel, niceTicks, prettyModel, visibleText, visibleToken } from "@/lib/format";

describe("fmt", () => {
  it("rounds to two decimals", () => {
    expect(fmt(356.92063751913037)).toBe("356.92");
    expect(fmt(-0.977872)).toBe("-0.98");
  });
  it("keeps tiny nonzero values from reading as zero", () => {
    expect(fmt(1.18e-9)).toBe("1.2e-9");
    expect(fmt(0)).toBe("0.00");
  });
  it("never prints negative zero", () => {
    expect(fmt(-0)).toBe("0.00");
  });
  it("says none for a missing value", () => {
    expect(fmt(null)).toBe("none");
    expect(fmt(undefined)).toBe("none");
    expect(fmt(Number.NaN)).toBe("none");
  });
  it("signs positive values", () => {
    expect(fmtSigned(1.5)).toBe("+1.50");
    expect(fmtSigned(-1.5)).toBe("-1.50");
  });
});

describe("intervals", () => {
  it("prints [lo, hi]", () => {
    expect(fmtInterval([-1.0467, -0.909])).toBe("[-1.05, -0.91]");
    expect(fmtInterval(null)).toBe("none");
  });
});

describe("labels", () => {
  it("names the recorded model plainly", () => {
    expect(prettyModel("gemma-3-4b-it")).toBe("Gemma 3 4B");
    expect(prettyModel("test-tiny-gemma3")).toBe("test-tiny-gemma3");
  });
  it("names hops", () => {
    expect(hopLabel("0")).toBe("Intervened");
    expect(hopLabel("1")).toBe("1 hop away");
    expect(hopLabel("3")).toBe("3 hops away");
  });
  it("formats shares as percentages", () => {
    expect(fmtPercent(1)).toBe("100%");
    expect(fmtPercent(0.015625)).toBe("1.6%");
    expect(fmtPercent(0.001953125)).toBe("0.20%");
  });
});

describe("text from the random test model", () => {
  it("replaces control characters and keeps newlines", () => {
    expect(visibleText("a\u0000b\u000bc\nd")).toBe("a\uFFFDb\uFFFDc\nd");
  });
  it("gives bare whitespace tokens a visible form", () => {
    expect(visibleToken(" ")).toBe("\u2423");
    expect(visibleToken(" the")).toBe("\u00A0the");
  });
});

describe("niceTicks", () => {
  it("lands on round numbers inside the range", () => {
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(-20, 390, 4)).toEqual([0, 100, 200, 300]);
  });
  it("includes zero exactly when it spans zero", () => {
    expect(niceTicks(-1.3, 1.3, 3)).toContain(0);
  });
});
