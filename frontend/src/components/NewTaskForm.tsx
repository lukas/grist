import { useState, type KeyboardEvent } from "react";

type Props = {
  repo: string;
  onCreateRun: (goal: string) => void;
  onPickRepo: () => void;
};

export function NewTaskForm({ repo, onCreateRun, onPickRepo }: Props) {
  const [goal, setGoal] = useState("");

  const submit = () => {
    if (!goal.trim()) return;
    if (!repo) {
      onPickRepo();
      return;
    }
    onCreateRun(goal.trim());
    setGoal("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <h2 className="mb-1 text-xl font-semibold text-white">New task</h2>
        <p className="mb-6 text-sm text-muted">
          {repo
            ? <>Working in <span className="font-mono text-gray-300">{repo.split("/").slice(-2).join("/")}</span></>
            : <button type="button" className="text-accent hover:underline" onClick={onPickRepo}>Pick a repo first</button>
          }
        </p>

        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted" htmlFor="goal">
            Goal
          </label>
          <textarea
            id="goal"
            className="w-full rounded-lg border border-border/60 bg-black/30 px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:border-accent focus:outline-none"
            placeholder="What should the agents build or change?"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
        </div>

        <button
          type="button"
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-30"
          disabled={!goal.trim() || !repo}
          onClick={submit}
        >
          Run
        </button>
        <p className="mt-2 text-center text-[11px] text-muted">
          {"\u2318"}+Enter to submit
        </p>
      </div>
    </div>
  );
}
