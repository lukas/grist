import { useEffect, useState } from "react";

type Props = {
  currentRepo?: string;
  onSelect: (repoPath: string) => void;
  onCreateRepo: () => void;
  onCancel: () => void;
};

export function RepoDialog({ currentRepo, onSelect, onCreateRepo, onCancel }: Props) {
  const [recent, setRecent] = useState<string[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.grist.recentRepos().then(setRecent);
  }, []);

  const validateAndSelect = async (p: string) => {
    setValidating(true);
    setError("");
    const isGit = await window.grist.isGitRepo(p);
    setValidating(false);
    if (isGit) {
      onSelect(p);
    } else {
      setError(`"${p}" is not a git repo. Initialize it first?`);
    }
  };

  const browse = async () => {
    setError("");
    const picked = await window.grist.pickRepo();
    if (!picked) return;
    const isGit = await window.grist.isGitRepo(picked);
    if (isGit) {
      onSelect(picked);
    } else {
      setPathInput(picked);
      setError(`"${picked}" is not a git repo. Initialize it first?`);
    }
  };

  const initHere = async () => {
    const target = pathInput || undefined;
    setError("");
    const result = await window.grist.initRepo(target);
    if (result) {
      onSelect(result);
    } else {
      setError("Failed to initialize repo.");
    }
  };

  const visibleRecent = recent.filter((r) => r !== currentRepo);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="max-h-[80vh] w-full max-w-md overflow-auto rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-white">Open a project</h2>
        <p className="mb-4 text-xs text-muted">Pick an existing git repo or create a new one.</p>

        {/* Recent repos */}
        {visibleRecent.length > 0 && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Recent</h3>
            <ul className="max-h-40 space-y-0.5 overflow-auto">
              {visibleRecent.map((r) => (
                <li key={r}>
                  <button
                    type="button"
                    className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-white/10"
                    title={r}
                    onClick={() => onSelect(r)}
                  >
                    {r.replace(/^\/Users\/[^/]+/, "~")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Paste / type a path */}
        <section className="mb-4">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Enter path</h3>
          <div className="flex gap-1">
            <input
              className="min-w-0 flex-1 rounded border border-border bg-black/30 px-2 py-1 text-sm font-mono"
              placeholder="/path/to/repo"
              value={pathInput}
              onChange={(e) => { setPathInput(e.target.value); setError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathInput.trim()) {
                  e.preventDefault();
                  void validateAndSelect(pathInput.trim());
                }
              }}
            />
            <button
              type="button"
              disabled={!pathInput.trim() || validating}
              className="rounded bg-accent px-2 py-1 text-sm text-white disabled:opacity-40"
              onClick={() => void validateAndSelect(pathInput.trim())}
            >
              Open
            </button>
          </div>
        </section>

        {/* Error + git init prompt */}
        {error && (
          <div className="mb-3 rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-xs text-amber-300">
            <p>{error}</p>
            <button
              type="button"
              className="mt-1 rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600"
              onClick={() => void initHere()}
            >
              Run git init here
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded bg-accent px-3 py-2 text-sm text-white"
            onClick={() => void browse()}
          >
            Browse…
          </button>
          <button
            type="button"
            className="flex-1 rounded border border-emerald-600 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-900/30"
            onClick={onCreateRepo}
          >
            Create new repo…
          </button>
          <button
            type="button"
            className="rounded border border-border px-3 py-2 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
