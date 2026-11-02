"use client";

import { useId } from "react";
import type { ApiError } from "@/lib/api";
import { prettyModel } from "@/lib/format";

export const TEST_MODEL_TEXT = "Test model. Random weights verify the software. This text and these numbers have no scientific meaning.";

export function TestModelBanner() {
  return (
    <div
      role="status"
      data-testid="test-banner"
      className="sticky top-0 z-20 border-b border-warn-border bg-warn-bg px-6 py-2 text-[13px] font-medium text-warn-text"
    >
      <div className="mx-auto max-w-[1344px]">{TEST_MODEL_TEXT}</div>
    </div>
  );
}

export function recordedText(model?: string | null): string {
  return `Recorded run. ${prettyModel(model ?? "gemma-3-4b-it")}, read only.`;
}

export function RecordedLabel({ model }: { model?: string | null }) {
  return (
    <span data-testid="recorded-label" className="text-[12px] text-text-3">
      {recordedText(model)}
    </span>
  );
}

export function Card({ title, aside, children, className = "", testid }: { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string; testid?: string }) {
  return (
    <section data-testid={testid} className={`card flex flex-col gap-3 p-4 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {title && <h2 className="cap m-0 font-normal">{title}</h2>}
          {aside && <span className="num text-[12px] text-text-2">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} className="rounded-lg border border-dashed border-border-input px-4 py-5 text-[13px] leading-relaxed text-text-3">
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error: ApiError | string | null | undefined }) {
  if (!error) return null;
  const text = typeof error === "string" ? error : error.message;
  return (
    <div role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2.5 text-[13px] leading-relaxed text-warn-text">
      {text}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="note m-0 py-2">
      Loading {what}.
    </p>
  );
}

export function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-[10px] bg-surface-2 p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`h-8 flex-1 rounded-[7px] border-0 px-2.5 text-[13px] font-medium whitespace-nowrap ${
              on ? "bg-surface text-text shadow-[0_1px_2px_rgba(0,0,0,0.4)]" : "bg-transparent text-text-3 hover:text-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={`-mb-px h-10 border-0 border-b-2 bg-transparent px-3 text-[14px] font-medium ${
              on ? "border-text text-text" : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex h-10 w-full items-center justify-between gap-3 border-0 bg-transparent p-0 text-left text-[13px] text-text-2"
    >
      <span>{label}</span>
      <span className={`relative h-5 w-[34px] flex-none rounded-[10px] ${checked ? "bg-accent" : "bg-[#34363E]"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-text transition-[left] ${checked ? "left-4" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="lbl">
        {label}
      </label>
      {children(id)}
      {hint && <span className="note">{hint}</span>}
    </div>
  );
}

export function BarLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="cap">
      {children}
    </label>
  );
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex max-w-[860px] flex-col gap-1.5">
      <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
      {children && <p className="m-0 text-[14px] leading-relaxed text-text-2">{children}</p>}
    </div>
  );
}

/** A step slider with a play control. Steps need not be consecutive. */
export function StepScrubber({ steps, step, onChange, playing, onTogglePlay }: { steps: number[]; step: number | null; onChange: (s: number) => void; playing?: boolean; onTogglePlay?: () => void }) {
  const at = step === null ? 0 : Math.max(0, steps.indexOf(step));
  return (
    <div className="flex items-center gap-3">
      {onTogglePlay && (
        <button type="button" aria-label={playing ? "Pause" : "Play through the steps"} onClick={onTogglePlay} className="flex size-9 flex-none items-center justify-center rounded-full border border-border-input bg-surface text-text hover:bg-chip">
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <rect x="3" y="2.5" width="3" height="9" rx="1" />
              <rect x="8" y="2.5" width="3" height="9" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M4 2.5v9l7.5-4.5z" />
            </svg>
          )}
        </button>
      )}
      <input
        type="range"
        aria-label="Step"
        aria-valuetext={step === null ? "no step" : `step ${step}`}
        className="h-7 min-w-0 flex-1"
        min={0}
        max={Math.max(0, steps.length - 1)}
        value={at}
        disabled={!steps.length}
        onChange={(e) => onChange(steps[Number(e.target.value)])}
      />
      <span className="num min-w-16 text-right text-[12px] text-text-2" data-testid="step-label">
        {step === null ? "no step" : `step ${step}`}
      </span>
    </div>
  );
}
