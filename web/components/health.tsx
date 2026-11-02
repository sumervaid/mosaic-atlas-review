"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { API_URL, ApiEpoch, START_COMMAND, request } from "@/lib/api";
import type { Health } from "@/lib/types";

type Status = "checking" | "up" | "down";

const HealthContext = createContext<{ health: Health | null; status: Status }>({ health: null, status: "checking" });

export const useHealth = () => useContext(HealthContext);

/** A long fork can slow one answer down, so only repeated network failures count as down. */
const FAILURES_BEFORE_DOWN = 2;

export function ApiDownNotice() {
  return (
    <div role="alert" className="card mx-auto mt-16 flex max-w-[640px] flex-col gap-3 p-6">
      <h1 className="m-0 text-[18px] font-semibold">The API cannot be reached</h1>
      <p className="m-0 text-[14px] leading-relaxed text-text-2">
        MOSAIC Atlas reads every number from the API at <span className="num text-text">{API_URL}</span>. Nothing is shown until it answers.
      </p>
      <p className="m-0 text-[14px] leading-relaxed text-text-2">Start it from the repository root with this command.</p>
      <code className="num block rounded-md bg-bg p-3 text-[13px] text-text">{START_COMMAND}</code>
      <p className="note m-0">This page checks again every few seconds and reloads its data once the API answers.</p>
    </div>
  );
}

export function HealthGate({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status>("checking");
  const [epoch, setEpoch] = useState(0);
  const failures = useRef(0);
  const wasDown = useRef(false);

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const h = await request<Health>("/health", { signal: AbortSignal.timeout(15000) });
        if (!live) return;
        failures.current = 0;
        setHealth(h);
        setStatus("up");
        if (wasDown.current) {
          wasDown.current = false;
          setEpoch((e) => e + 1);
        }
      } catch {
        if (!live) return;
        failures.current += 1;
        if (failures.current >= FAILURES_BEFORE_DOWN) {
          wasDown.current = true;
          setStatus("down");
        }
      }
    };
    void check();
    const quick = setTimeout(() => void check(), 1200);
    const id = setInterval(() => void check(), 5000);
    return () => {
      live = false;
      clearTimeout(quick);
      clearInterval(id);
    };
  }, []);

  const down = status === "down";
  return (
    <HealthContext.Provider value={{ health, status }}>
      <ApiEpoch.Provider value={epoch}>
        {down && (
          <div className="min-h-screen bg-bg px-6">
            <ApiDownNotice />
          </div>
        )}
        <div hidden={down}>{children}</div>
      </ApiEpoch.Provider>
    </HealthContext.Provider>
  );
}
