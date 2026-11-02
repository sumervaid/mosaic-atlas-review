"use client";

import { useEffect, useState } from "react";
import { type ApiError, post, useFetch } from "@/lib/api";
import { readableDetail, readableProblems } from "@/lib/contagion";
import type { ComputeStatus, GcpRunResult } from "@/lib/types";
import { Main } from "./shell";
import { Card, EmptyState, ErrorNote, Field, Loading, PageTitle } from "./ui";

type Pending = "up" | "down" | null;

export function SetupScreen() {
  const compute = useFetch<ComputeStatus>("/compute");
  const [status, setStatus] = useState<ComputeStatus | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [project, setProject] = useState("");
  const [zone, setZone] = useState("");
  const [profile, setProfile] = useState("");
  const [hfPath, setHfPath] = useState("");
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GcpRunResult | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [runResult, setRunResult] = useState<GcpRunResult | null>(null);
  const [runError, setRunError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);

  const fill = (c: ComputeStatus) => {
    setStatus(c);
    setKeyPath(c.settings.key_path);
    setProject(c.settings.project);
    setZone(c.settings.zone);
    setProfile(c.settings.profile);
    setHfPath(c.settings.hf_token_path);
  };

  useEffect(() => {
    if (compute.data) fill(compute.data);
  }, [compute.data]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    setPreview(null);
    try {
      fill(await post<ComputeStatus>("/compute/gcp/configure", { key_path: keyPath, project, zone, profile, hf_token_path: hfPath }));
      setSaved(true);
    } catch (err) {
      setSaveError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const showPreview = async () => {
    setPreviewError(null);
    setPreview(null);
    try {
      setPreview(await post<GcpRunResult>("/compute/gcp/up", { dry_run: true }));
    } catch (err) {
      setPreviewError(err as ApiError);
    }
  };

  const confirmRun = async () => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(await post<GcpRunResult>(`/compute/gcp/${action}`, { dry_run: false }));
    } catch (err) {
      setRunError(err as ApiError);
    } finally {
      setRunning(false);
    }
  };

  if (compute.error && !status) return <Main narrow><ErrorNote error={compute.error} /></Main>;
  if (!status) return <Main narrow><Loading what="the compute settings" /></Main>;

  const problems = readableProblems(status.problems, status.settings.key_path);
  const ready = problems.length === 0;
  const chosen = status.profiles[profile];
  return (
    <Main narrow>
      <PageTitle title="Setup">Point MOSAIC Atlas at compute. Live experiments on Gemma need a GPU machine. Recorded runs and the test model need nothing here.</PageTitle>
      <div className="flex flex-wrap items-start gap-4">
        <form onSubmit={save} className="card flex min-w-[320px] flex-[3_1_420px] flex-col gap-3 p-4" data-testid="setup-form">
          <h2 className="cap m-0 font-normal">Google Cloud</h2>
          <Field label="Path to a service account key file" hint="Only this path is stored. The key's contents never leave this machine.">
            {(id) => <input id={id} className="field num w-full" spellCheck={false} autoComplete="off" placeholder="/path/to/service-account.json" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} data-testid="key-path" />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project">{(id) => <input id={id} className="field num w-full" spellCheck={false} placeholder="taken from the key if blank" value={project} onChange={(e) => setProject(e.target.value)} />}</Field>
            <Field label="Zone">{(id) => <input id={id} className="field num w-full" spellCheck={false} value={zone} onChange={(e) => setZone(e.target.value)} />}</Field>
          </div>
          <Field label="Machine profile" hint={chosen ? `${chosen.label}. Machine ${chosen.machine}, ${chosen.gpus} GPU.` : undefined}>
            {(id) => (
              <select id={id} className="field w-full" value={profile} onChange={(e) => setProfile(e.target.value)}>
                {Object.keys(status.profiles).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Path to a file with a Hugging Face token" hint="The token needs access to Gemma 3. Only this path is stored.">
            {(id) => <input id={id} className="field num w-full" spellCheck={false} autoComplete="off" placeholder="/path/to/hf_token" value={hfPath} onChange={(e) => setHfPath(e.target.value)} data-testid="hf-path" />}
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy} data-testid="setup-save">
              {busy ? "Saving" : "Save settings"}
            </button>
            {saved && <span role="status" className="text-[13px] text-ok-text">Saved.</span>}
          </div>
          <ErrorNote error={saveError} />
        </form>

        <div className="flex min-w-[300px] flex-[2_1_340px] flex-col gap-4">
          <Card title="Status" testid="setup-status">
            {ready ? (
              <p className="m-0 text-[13px] text-ok-text">Settings are complete.</p>
            ) : (
              <>
                <p className="m-0 text-[13px] text-text-2">Still needed before a machine can start.</p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] text-warn-text" data-testid="setup-problems">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            )}
            {status.key_error && <ErrorNote error={status.key_error} />}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-divider pt-3 text-[13px]">
              <dt className="text-text-3">GPU on this machine</dt>
              <dd className="m-0 text-right">{status.gpu_here ? "Yes" : "No"}</dd>
              <dt className="text-text-3">Loaded models</dt>
              <dd className="num m-0 text-right">{status.loaded_models.join(", ") || "None"}</dd>
            </dl>
          </Card>
          {status.key && (
            <Card title="Key on file" testid="key-info">
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-text-3">Account</dt>
                <dd className="num m-0 text-right break-all">{status.key.client_email}</dd>
                <dt className="text-text-3">Project</dt>
                <dd className="num m-0 text-right break-all">{status.key.project_id}</dd>
              </dl>
              {status.key.group_or_world_readable && (
                <p role="alert" className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn-text" data-testid="key-readable">
                  Other users on this machine can read this key file. Restrict it with <code className="num">chmod 600</code>.
                </p>
              )}
            </Card>
          )}
          {!status.key && !status.key_error && <EmptyState>No key is configured. Save a path to see its account and project here.</EmptyState>}
        </div>
      </div>

      <Card title="Machine" testid="machine-card">
        <p className="m-0 text-[13px] leading-relaxed text-text-2">Preview first. Preview runs nothing and costs nothing. A running machine bills by the hour until you delete it.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={showPreview} data-testid="preview-commands">Preview commands</button>
          <button type="button" className="btn" disabled={!ready || running} onClick={() => setPending("up")} data-testid="provision">Provision machine</button>
          <button type="button" className="btn btn-danger" disabled={running || !status.key || !status.settings.project} onClick={() => setPending("down")} data-testid="delete-machine">Delete machine</button>
        </div>
        {pending && (
          <div role="alertdialog" aria-label="Confirm" data-testid="confirm" className="flex flex-col gap-2.5 rounded-lg border border-warn-border bg-warn-bg p-3">
            <p className="m-0 text-[13px] leading-relaxed text-warn-text">
              {pending === "up"
                ? "This starts a real GPU machine on your Google Cloud account. A running machine bills by the hour until you delete it. Continue?"
                : `This deletes the machine named ${status.settings.instance} and everything on its disk. Continue?`}
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-danger" onClick={confirmRun}>{pending === "up" ? "Yes, provision and bill by the hour" : "Yes, delete the machine"}</button>
              <button type="button" className="btn" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {running && <p role="status" className="note m-0">Running. This can take several minutes.</p>}
        <ErrorNote error={previewError ? readableDetail(previewError.message, status.settings.key_path) : null} />
        <ErrorNote error={runError ? readableDetail(runError.message, status.settings.key_path) : null} />
        {preview && (
          <div className="flex flex-col gap-2" data-testid="preview-output">
            <span className="lbl">Commands that would run</span>
            <pre className="num m-0 overflow-x-auto rounded-md bg-bg p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-text-2">{preview.commands?.join("\n")}</pre>
            {preview.tunnel && (
              <>
                <span className="lbl">Tunnel, to reach the API on that machine</span>
                <pre className="num m-0 overflow-x-auto rounded-md bg-bg p-3 text-[12px] whitespace-pre-wrap text-text-2">{preview.tunnel}</pre>
              </>
            )}
          </div>
        )}
        {runResult && (
          <div className="flex flex-col gap-2" data-testid="run-result">
            <span className={`text-[13px] ${runResult.ok ? "text-ok-text" : "text-warn-text"}`}>{runResult.ok ? "All commands finished." : "A command failed. Output follows."}</span>
            <pre className="num m-0 overflow-x-auto rounded-md bg-bg p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-text-2">
              {runResult.steps?.map((s) => `${s.returncode === 0 ? "ok" : `exit ${s.returncode}`}  ${s.command}${s.stderr && s.returncode !== 0 ? `\n${s.stderr}` : ""}`).join("\n")}
            </pre>
          </div>
        )}
      </Card>
    </Main>
  );
}
