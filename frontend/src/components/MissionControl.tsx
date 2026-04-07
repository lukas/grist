import { useEffect, useState, type KeyboardEvent } from "react";

type Props = {
  repo: string;
  goal: string;
  notes: string;
  jobId: number | null;
  tick: number;
  provider: string;
  onGoalChange: (s: string) => void;
  onNotesChange: (s: string) => void;
  onPickRepo: () => void;
  onCreateRun: () => void;
  onOpenSettings: () => void;
};

const PROVIDER_DOT: Record<string, string> = {
  claude: "bg-orange-400",
  codex: "bg-green-400",
  kimi: "bg-blue-400",
  mock: "bg-gray-400",
};

export function MissionControl({
  repo,
  goal,
  notes,
  jobId,
  tick,
  provider,
  onGoalChange,
  onNotesChange,
  onPickRepo,
  onCreateRun,
  onOpenSettings,
}: Props) {
  const [job, setJob] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!jobId) { setJob(null); return; }
    void window.grist.getJob(jobId).then((j) => setJob(j as Record<string, unknown>));
  }, [jobId, tick]);

  const tryCreateRun = () => {
    if (!goal.trim()) return;
    void onCreateRun();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); tryCreateRun(); }
  };

  return (
    <header className="flex items-center gap-2 border-b border-border/50 bg-[#0e1420] px-3 py-1.5 text-xs">
      <span className="text-sm font-semibold text-white">Grist</span>

      <button
        type="button"
        className="truncate rounded px-1.5 py-0.5 text-muted hover:bg-white/5 hover:text-white"
        onClick={onPickRepo}
        title={repo || "Pick repo"}
      >
        {repo ? repo.split("/").slice(-2).join("/") : "repo…"}
      </button>

      <input
        className="min-w-[180px] flex-1 rounded border border-border/40 bg-transparent px-2 py-1 text-gray-100 placeholder:text-gray-600 focus:border-accent focus:outline-none"
        placeholder="Goal…"
        value={goal}
        onChange={(e) => onGoalChange(e.target.value)}
        onKeyDown={onKey}
      />
      <input
        className="w-36 rounded border border-border/40 bg-transparent px-2 py-1 text-gray-300 placeholder:text-gray-600 focus:border-accent focus:outline-none"
        placeholder="Notes…"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        onKeyDown={onKey}
      />

      <button
        type="button"
        className="rounded bg-emerald-600 px-2.5 py-1 text-white disabled:opacity-30"
        disabled={!goal.trim()}
        onClick={tryCreateRun}
      >
        Run
      </button>

      <button
        type="button"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-white/5 hover:text-white"
        onClick={onOpenSettings}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${PROVIDER_DOT[provider] ?? "bg-gray-500"}`} />
        {provider || "provider"}
      </button>

      {job && (
        <span className="text-muted">
          {String(job.status)} · {String(job.total_tokens_used ?? 0)} tok
        </span>
      )}

      {jobId && (
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-amber-400 hover:bg-amber-900/30"
            onClick={() => void window.grist.jobControl({ type: "pause_all", jobId })}
            title="Pause all"
          >
            ⏸
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-emerald-400 hover:bg-emerald-900/30"
            onClick={() => void window.grist.jobControl({ type: "resume_all", jobId })}
            title="Resume all"
          >
            ▶
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-red-400 hover:bg-red-900/30"
            onClick={() => void window.grist.jobControl({ type: "stop_run", jobId })}
            title="Stop run"
          >
            ■
          </button>
        </div>
      )}
    </header>
  );
}
