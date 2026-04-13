import { useEffect, useMemo, useState } from "react";

type Props = {
  onSelect: (repoPath: string) => void;
  onCancel: () => void;
};

function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function CreateRepoDialog({ onSelect, onCancel }: Props) {
  const [name, setName] = useState("");
  const [defaultParent, setDefaultParent] = useState("");
  const [customParent, setCustomParent] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.grist.repoDefaults().then((defaults) => setDefaultParent(defaults.defaultParent));
  }, []);

  const parentDir = customParent.trim() || defaultParent;
  const previewPath = useMemo(() => {
    const trimmedName = name.trim();
    if (!trimmedName || !parentDir) return "";
    return `${parentDir.replace(/\/+$/, "")}/${trimmedName}`;
  }, [name, parentDir]);

  const browseForParent = async () => {
    setError("");
    const picked = await window.grist.pickRepo();
    if (picked) setCustomParent(picked);
  };

  const createRepo = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a repo name.");
      return;
    }
    setCreating(true);
    setError("");
    const result = await window.grist.createRepo({
      name: trimmedName,
      parentDir: customParent.trim() || undefined,
    });
    setCreating(false);
    if (result.ok && result.path) {
      onSelect(result.path);
    } else {
      setError(result.error || "Failed to create repo.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-white">Create a new repo</h2>
        <p className="mb-4 text-xs text-muted">Enter a name and Grist will initialize a git repo for you.</p>

        <div className="space-y-4">
          <label className="block">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Repo name</div>
            <input
              autoFocus
              className="w-full rounded border border-border bg-black/30 px-3 py-2 text-sm"
              placeholder="my-new-project"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) {
                  e.preventDefault();
                  void createRepo();
                }
              }}
            />
          </label>

          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Default location</div>
            <div className="rounded border border-border/60 bg-black/20 px-3 py-2 text-sm text-gray-300">
              {defaultParent ? shortenHome(defaultParent) : "Loading..."}
            </div>
          </div>

          <label className="block">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Custom parent folder (optional)</div>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-black/30 px-3 py-2 text-sm font-mono"
                placeholder={defaultParent || "/path/to/parent"}
                value={customParent}
                onChange={(e) => {
                  setCustomParent(e.target.value);
                  setError("");
                }}
              />
              <button
                type="button"
                className="rounded border border-border px-3 py-2 text-sm text-gray-200 hover:bg-white/10"
                onClick={() => void browseForParent()}
              >
                Browse…
              </button>
            </div>
          </label>

          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Repo path preview</div>
            <div className="rounded border border-border/60 bg-black/20 px-3 py-2 text-sm text-gray-300">
              {previewPath ? shortenHome(previewPath) : "Enter a repo name to see the target path"}
            </div>
          </div>

          {error && (
            <div className="rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-2 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || !defaultParent || creating}
            className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-40"
            onClick={() => void createRepo()}
          >
            {creating ? "Creating..." : "Create repo"}
          </button>
        </div>
      </div>
    </div>
  );
}
