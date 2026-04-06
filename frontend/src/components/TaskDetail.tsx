import { useEffect, useState } from "react";

type Task = Record<string, unknown>;

export function TaskDetail({
  jobId,
  taskId,
  tick,
  onRefresh,
}: {
  jobId: number | null;
  taskId: number | null;
  tick: number;
  onRefresh: () => void;
}) {
  const [task, setTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!jobId || taskId == null) {
      setTask(null);
      return;
    }
    void window.grist.getTasks(jobId).then((rows) => {
      const t = (rows as Task[]).find((r) => r.id === taskId) || null;
      setTask(t);
    });
  }, [jobId, taskId, tick]);

  if (!jobId || taskId == null) return <p className="text-muted text-sm">Select a task.</p>;
  if (!task) return <p className="text-sm">Loading…</p>;

  const scratchpad = task.scratchpad_path as string;
  const worktree = task.worktree_path as string | null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto text-sm">
      <h2 className="font-semibold text-white">Task #{String(task.id)} — {String(task.role)}</h2>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted">Status</div>
          <div>{String(task.status)}</div>
        </div>
        <div>
          <div className="text-muted">Provider</div>
          <div>{String(task.assigned_model_provider)}</div>
        </div>
        <div>
          <div className="text-muted">Write mode</div>
          <div>{String(task.write_mode)}</div>
        </div>
        <div>
          <div className="text-muted">Workspace</div>
          <div>{String(task.workspace_repo_mode)}</div>
        </div>
      </div>
      <div>
        <div className="text-muted text-xs">Goal</div>
        <div className="whitespace-pre-wrap">{String(task.goal)}</div>
      </div>
      <div>
        <div className="text-muted text-xs">Scope</div>
        <pre className="max-h-24 overflow-auto rounded bg-black/30 p-2 text-xs">{String(task.scope_json)}</pre>
      </div>
      <div>
        <div className="text-muted text-xs">Allowed tools</div>
        <pre className="max-h-20 overflow-auto text-xs">{String(task.allowed_tools_json)}</pre>
      </div>
      <div>
        <div className="text-muted text-xs">Current / next</div>
        <div>{String(task.current_action)} → {String(task.next_action)}</div>
      </div>
      <div>
        <div className="text-muted text-xs">Findings</div>
        <pre className="max-h-32 overflow-auto rounded bg-black/30 p-2 text-xs">{String(task.findings_json)}</pre>
      </div>
      <div>
        <div className="text-muted text-xs">Open questions</div>
        <pre className="max-h-24 overflow-auto text-xs">{String(task.open_questions_json)}</pre>
      </div>
      <div>
        <div className="text-muted text-xs">Scratchpad path</div>
        <div className="break-all font-mono text-xs">{scratchpad}</div>
      </div>
      {worktree && (
        <div>
          <div className="text-muted text-xs">Worktree</div>
          <div className="break-all font-mono text-xs">{worktree}</div>
          <button
            type="button"
            className="mt-1 mr-2 rounded border border-border px-2 py-1 text-xs"
            onClick={() => void window.grist.openPath(worktree)}
          >
            Open in Finder
          </button>
          <button
            type="button"
            className="mt-1 rounded border border-border px-2 py-1 text-xs"
            onClick={() => {
              void window.grist.spawnVerifier(jobId, taskId).then(onRefresh);
            }}
          >
            Spawn verifier (after patch)
          </button>
        </div>
      )}
      {String(task.kind) === "patch_writer" && (
        <button
          type="button"
          className="rounded bg-slate-600 px-2 py-1 text-xs text-white"
          onClick={() => void window.grist.spawnVerifier(jobId, taskId).then(onRefresh)}
        >
          Queue verifier for this patch task
        </button>
      )}
    </div>
  );
}
