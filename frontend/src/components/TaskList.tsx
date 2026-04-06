import { useEffect, useState } from "react";

type Task = {
  id: number;
  role: string;
  kind: string;
  status: string;
  assigned_model_provider: string;
  confidence: number;
  tokens_used: number;
  workspace_repo_mode: string;
  goal: string;
  findings_json: string;
  dependencies_json: string;
};

export function TaskList({
  jobId,
  tick,
  selectedId,
  onSelect,
  view,
  onRefresh,
}: {
  jobId: number | null;
  tick: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  view: "table" | "dag";
  onRefresh: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    if (!jobId) {
      setTasks([]);
      return;
    }
    void window.grist.getTasks(jobId).then((t) => setTasks(t as Task[]));
  }, [jobId, tick]);

  if (!jobId) return <p className="text-muted text-sm">Create a job to see tasks.</p>;

  const snippet = (t: Task) => {
    try {
      const f = JSON.parse(t.findings_json || "[]") as unknown[];
      return Array.isArray(f) && f.length ? String(f[f.length - 1]).slice(0, 80) : "—";
    } catch {
      return "—";
    }
  };

  if (view === "dag") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto text-xs">
        <h2 className="font-semibold text-white">Task graph (deps)</h2>
        {tasks.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={`rounded border p-2 text-left ${selectedId === t.id ? "border-accent" : "border-border"}`}
          >
            <div className="font-medium text-accent">
              #{t.id} {t.role}
            </div>
            <div className="text-muted">deps: {t.dependencies_json || "[]"}</div>
            <div className="text-muted">status: {t.status}</div>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto text-xs">
      <h2 className="shrink-0 font-semibold text-white">Tasks</h2>
      {tasks.map((t) => (
        <div
          key={t.id}
          className={`cursor-pointer rounded border p-2 ${selectedId === t.id ? "border-accent bg-[#1a2430]" : "border-border"}`}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => e.key === "Enter" && onSelect(t.id)}
          role="button"
          tabIndex={0}
        >
          <div className="flex justify-between gap-2">
            <span className="font-medium text-white">{t.role}</span>
            <span className="text-muted">{t.status}</span>
          </div>
          <div className="text-muted">
            {t.assigned_model_provider} · tok {t.tokens_used} · conf {t.confidence?.toFixed?.(2) ?? t.confidence}
          </div>
          <div className="truncate text-muted">{snippet(t)}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <button
              type="button"
              className="rounded bg-amber-800 px-1 py-0.5 text-white"
              onClick={(e) => {
                e.stopPropagation();
                void window.grist.taskControl({ type: "pause", taskId: t.id }).then(onRefresh);
              }}
            >
              Pause
            </button>
            <button
              type="button"
              className="rounded bg-red-900 px-1 py-0.5 text-white"
              onClick={(e) => {
                e.stopPropagation();
                void window.grist.taskControl({ type: "stop", taskId: t.id }).then(onRefresh);
              }}
            >
              Stop
            </button>
            <button
              type="button"
              className="rounded bg-blue-800 px-1 py-0.5 text-white"
              onClick={(e) => {
                e.stopPropagation();
                const g = window.prompt("Redirect goal", t.goal);
                if (g) void window.grist.taskControl({ type: "redirect", taskId: t.id, newGoal: g }).then(onRefresh);
              }}
            >
              Redirect
            </button>
            <button
              type="button"
              className="rounded bg-purple-800 px-1 py-0.5 text-white"
              onClick={(e) => {
                e.stopPropagation();
                const g = window.prompt("Fork goal", t.goal);
                if (g)
                  void window.grist
                    .taskControl({ type: "fork", taskId: t.id, newGoal: g, stopOriginal: false })
                    .then(onRefresh);
              }}
            >
              Fork
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
