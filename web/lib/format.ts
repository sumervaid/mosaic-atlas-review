// Number and text formatting. Every value shown in the interface goes through here.

/** Two decimals. Tiny nonzero values keep their size in exponent form rather than reading as zero. */
export function fmt(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "none";
  const threshold = 0.5 * 10 ** -digits;
  if (x !== 0 && Math.abs(x) < threshold) return x.toExponential(1);
  if (Math.abs(x) >= 100000) return x.toExponential(2).replace("e+", "e");
  const s = x.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

export function fmtSigned(x: number | null | undefined, digits = 2): string {
  const s = fmt(x, digits);
  return x !== null && x !== undefined && x > 0 ? `+${s}` : s;
}

export function fmtInterval(ci: [number, number] | null | undefined, digits = 2): string {
  if (!ci) return "none";
  return `[${fmt(ci[0], digits)}, ${fmt(ci[1], digits)}]`;
}

export function fmtPercent(share: number): string {
  const pct = share * 100;
  if (pct === 0) return "0%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

/** "gemma-3-4b-it" reads as "Gemma 3 4B". Unknown names stay as they are. */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return "unknown model";
  const m = /^gemma-(\d+)-(\d+)b/.exec(id);
  return m ? `Gemma ${m[1]} ${m[2]}B` : id;
}

/** Message text can hold control characters on the random test model. Show them as a replacement mark. */
export function visibleText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "\uFFFD");
}

/** A token strip needs a visible form for bare whitespace. */
export function visibleToken(token: string): string {
  const shown = visibleText(token);
  if (shown === "") return "\u00A0";
  if (/^ +$/.test(shown)) return "\u2423".repeat(shown.length);
  return shown.replace(/ /g, "\u00A0").replace(/\n/g, "\u21B5");
}

export function hopLabel(hop: string): string {
  if (hop === "0") return "Intervened";
  if (hop === "1") return "1 hop away";
  return `${hop} hops away`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Evenly spaced axis ticks on round numbers. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

/** Shortest axis label that keeps ticks distinct. */
export function fmtTick(x: number, step: number): string {
  if (x === 0) return "0";
  const abs = Math.abs(step);
  if (abs >= 1) return String(Math.round(x * 100) / 100);
  if (abs >= 0.001) return x.toFixed(Math.min(3, Math.ceil(-Math.log10(abs))));
  return x.toExponential(0);
}
