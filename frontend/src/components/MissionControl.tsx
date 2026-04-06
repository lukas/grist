import { useEffect, useState } from "react";

type Props = {
  repo: string;
  goal: string;
  notes: string;
  jobId: number | null;
  tick: number;
  onGoalChange: (s: string) => void;
  onNotesChange: (s: string) => void;
  onPickRepo: () => void;
  onCreateRun: () => void;
  onOpenSettings: () => void;
  view: "table" | "dag";
  onViewChange: (v: "table" | "dag") => void;
};

export function MissionControl({
  repo,
  goal,
  notes,
  jobId,
  tick,
  onGoalChange,
  onNotesChange,
  onPickRepo,
  onCreateRun,
  onOpenSettings,
  view,
  onViewChange,
}: Props) {
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [started, setStarted] = useState<number | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    void window.grist.getJob(jobId).then((j) => setJob(j as Record<string, unknown>));
  }, [jobId, tick]);

  const elapsed = started ? Math.floor((Date.now() - started) / 1000) : 0;

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-[#121922] px-3 py-2 text-sm">
      <h1 className="text-base font-semibold text-white">Grist</h1>
      <button type="button" className="rounded bg-accent px-2 py-1 text-white" onClick={onPickRepo}>
        Repo…
      </button>
      <span className="max-w-xs truncate text-muted" title={repo || "none"}>
        {repo || "no repo"}
      </span>
      <input
        className="min-w-[200px] flex-1 rounded border border-border bg-panel px-2 py-1"
        placeholder="Goal (e.g. find flaky auth tests)"
        value={goal}
        onChange={(e) => onGoalChange(e.target.value)}
      />
      <input
        className="w-48 rounded border border-border bg-panel px-2 py-1 text-xs"
        placeholder="Operator notes / constraints"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
      />
      <button
        type="button"
        className="rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-40"
        disabled={!repo || !goal.trim()}
        onClick={() => {
          setStarted(Date.now());
          void onCreateRun();
        }}
      >
        Plan &amp; run
      </button>
      <button type="button" className="rounded border border-border px-2 py-1" onClick={onOpenSettings}>
        Providers
      </button>
      <select
        className="rounded border border-border bg-panel px-1 py-1"
        value={view}
        onChange={(e) => onViewChange(e.target.value as "table" | "dag")}
      >
        <option value="table">Table</option>
        <option value="dag">DAG (deps)</option>
      </select>
      {job && (
        <>
          <span className="text-muted">status: {String(job.status)}</span>
          <span className="text-muted">tokens: {String(job.total_tokens_used ?? 0)}</span>
          <span className="text-muted">~$ {Number(job.total_estimated_cost ?? 0).toFixed(4)}</span>
          <span className="text-muted">{elapsed}s</span>
        </>
      )}
      {jobId && (
        <>
          <button
            type="button"
            className="rounded bg-amber-700 px-2 py-1 text-white"
            onClick={() => void window.grist.jobControl({ type: "pause_all", jobId })}
          >
            Pause all
          </button>
          <button
            type="button"
            className="rounded bg-emerald-800 px-2 py-1 text-white"
            onClick={() => void window.grist.jobControl({ type: "resume_all", jobId })}
          >
            Resume all
          </button>
          <button
            type="button"
            className="rounded bg-violet-700 px-2 py-1 text-white"
            onClick={() => void window.grist.jobControl({ type: "summarize_now", jobId })}
          >
            Summarize now
          </button>
          <button
            type="button"
            className="rounded bg-red-800 px-2 py-1 text-white"
            onClick={() => void window.grist.jobControl({ type: "stop_run", jobId })}
          >
            Stop run
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-1"
            onClick={() => void window.grist.runReducerNow(jobId)}
          >
            Reducer only
          </button>
        </>
      )}
    </header>
  );
}
