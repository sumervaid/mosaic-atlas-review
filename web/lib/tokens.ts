// The section 9 tokens, for code that draws on canvas. app/globals.css holds the same values for Tailwind.
export const tokens = {
  bg: "#0B0C0F",
  bgRaised: "#0E0F13",
  header: "#111216",
  surface: "#15161B",
  surface2: "#1B1D23",
  chip: "#1D1F25",
  border: "#24262D",
  divider: "#1E2026",
  borderInput: "#2E3038",
  text: "#ECEDF0",
  text2: "#C4C7CE",
  text3: "#9A9EA8",
  text4: "#8B8F99",
  accent: "#5B7BF0",
  accentText: "#8EA4F7",
  accentBg: "#1A2140",
  warn: "#E07B39",
  warnText: "#F29A63",
  warnBg: "#261A12",
  okText: "#5FBF7A",
} as const;

export const scales = {
  activation: ["#20232E", "#4660C8", "#A8BAFF"],
  difference: ["#F08C50", "#20232E", "#8EA4F7"],
} as const;

export const MONO_FONT = "'Geist Mono', ui-monospace, Menlo, monospace";
