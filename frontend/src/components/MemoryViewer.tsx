import { useEffect, useState } from "react";

type Props = {
  selection: MemorySelection;
  repo: string;
  onClose: () => void;
};

export function MemoryViewer({ selection, repo, onClose }: Props) {
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    if (!window.grist?.getMemory) { setContent("(memory API unavailable — restart app)"); return; }
    if (selection.type === "summary") {
      void window.grist.getMemory(repo).then((data) => {
        const text = selection.scope === "project" ? data.repoSummary : data.homeSummary;
        setContent(text);
        setDraft(text);
      }).catch(() => { setContent("(failed to load)"); });
    } else {
      void window.grist
        .getMemoryFile({
          scope: selection.scope,
          name: selection.name,
          repoPath: selection.scope === "project" ? repo : undefined,
        })
        .then((text) => {
          setContent(text);
          setDraft(text);
        }).catch(() => { setContent("(failed to load)"); });
    }
  }, [selection, repo]);

  const save = async () => {
    setSaving(true);
    await window.grist.updateMemorySummary({
      scope: selection.scope,
      content: draft,
      repoPath: selection.scope === "project" ? repo : undefined,
    });
    setContent(draft);
    setEditing(false);
    setSaving(false);
  };

  const isSummary = selection.type === "summary";
  const label = selection.scope === "project" ? "Project" : "Global";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
        <button
          type="button"
          className="text-muted hover:text-white"
          onClick={onClose}
          title="Back"
        >
          ←
        </button>
        <div className="flex-1 truncate">
          <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
          <span className="ml-1.5 text-xs text-white">{selection.name}</span>
        </div>
        {isSummary && !editing && (
          <button
            type="button"
            className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted hover:bg-white/10 hover:text-white"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
        {isSummary && editing && (
          <div className="flex gap-1">
            <button
              type="button"
              className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted hover:bg-white/10 hover:text-white"
              onClick={() => { setEditing(false); setDraft(content); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-accent/20 px-2 py-0.5 text-[10px] text-accent hover:bg-accent/30"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {editing ? (
          <textarea
            className="h-full w-full resize-none rounded bg-[#0a0e17] p-3 font-mono text-xs leading-relaxed text-gray-200 outline-none ring-1 ring-border/50 focus:ring-accent/50"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-300">
            {content || <span className="italic text-muted">Empty</span>}
          </pre>
        )}
      </div>
    </div>
  );
}
