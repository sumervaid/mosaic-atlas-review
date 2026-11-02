import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activationColor, contrast, differenceColor, luminance } from "@/lib/color";
import { scales, tokens } from "@/lib/tokens";

const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");

describe("design tokens", () => {
  it("match the Tailwind theme", () => {
    const map: Record<string, string> = { bg: "bg", bgRaised: "bg-raised", header: "header", surface: "surface", surface2: "surface-2", chip: "chip", border: "border", divider: "divider", borderInput: "border-input", text: "text", text2: "text-2", text3: "text-3", text4: "text-4", accent: "accent", accentText: "accent-text", accentBg: "accent-bg", warn: "warn", warnText: "warn-text", warnBg: "warn-bg", okText: "ok-text" };
    for (const [key, name] of Object.entries(map)) {
      expect(css.toLowerCase()).toContain(`--color-${name}: ${tokens[key as keyof typeof tokens].toLowerCase()};`);
    }
  });

  it("hold text contrast of at least 4.5 to 1 on every dark surface", () => {
    const surfaces = [tokens.bg, tokens.bgRaised, tokens.header, tokens.surface, tokens.surface2, tokens.chip];
    for (const fg of [tokens.text, tokens.text2, tokens.text3, tokens.text4, tokens.accentText, tokens.okText]) {
      for (const bg of surfaces) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens.warnText, tokens.warnBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.accentText, tokens.accentBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.text3, tokens.accentBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.bg, tokens.text)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("colour scales", () => {
  it("use the exact stops at their ends", () => {
    expect(activationColor(0)).toBe(scales.activation[0]);
    expect(activationColor(1)).toBe(scales.activation[2]);
    expect(differenceColor(-1)).toBe(scales.difference[0]);
    expect(differenceColor(0)).toBe(scales.difference[1]);
    expect(differenceColor(1)).toBe(scales.difference[2]);
  });
  it("rise in lightness along the activation scale", () => {
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const l = luminance(activationColor(t));
      expect(l).toBeGreaterThan(last);
      last = l;
    }
  });
  it("gain lightness away from the midpoint of the difference scale", () => {
    const mid = luminance(differenceColor(0));
    expect(luminance(differenceColor(-0.5))).toBeGreaterThan(mid);
    expect(luminance(differenceColor(0.5))).toBeGreaterThan(mid);
  });
  it("clamp values beyond the range", () => {
    expect(activationColor(9)).toBe(scales.activation[2]);
    expect(differenceColor(-9)).toBe(scales.difference[0]);
  });
});
