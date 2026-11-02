import { scales } from "./tokens";

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Sequential activation scale. t runs from 0 to 1. */
export function activationColor(t: number): string {
  const v = clamp(t, 0, 1);
  const [a, b, c] = scales.activation;
  return v < 0.5 ? mix(a, b, v * 2) : mix(b, c, (v - 0.5) * 2);
}

/** Diverging difference scale. t runs from -1 to 1 and zero is the neutral midpoint. */
export function differenceColor(t: number): string {
  const v = clamp(t, -1, 1);
  const [neg, mid, pos] = scales.difference;
  return v < 0 ? mix(mid, neg, -v) : mix(mid, pos, v);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const activationGradient = `linear-gradient(90deg, ${scales.activation.join(", ")})`;
export const differenceGradient = `linear-gradient(90deg, ${scales.difference.join(", ")})`;
