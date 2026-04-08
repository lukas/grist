import { useEffect, useState } from "react";

type Props = {
  repo: string;
  tick: number;
  selected: MemorySelection | null;
  onSelect: (sel: MemorySelection) => void;
};

export function MemoryDrawer({ repo, tick, selected, onSelect }: Props) {
  const [data, setData] = useState<MemoryData | null>(null);

  useEffect(() => {
    if (!repo || !window.grist?.getMemory) return;
    void window.grist.getMemory(repo).then(setData).catch(() => {
      setData({ repoSummary: "", homeSummary: "", repoFiles: [], homeFiles: [] });
    });
  }, [repo, tick]);

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted">
        {repo ? "Loading memory…" : "Select a repo first"}
      </div>
    );
  }

  const isActive = (scope: "project" | "global", type: "summary" | "file", name: string) =>
    selected?.scope === scope && selected?.type === type && selected?.name === name;

  const itemCls = (active: boolean) =>
    `block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors ${
      active
        ? "bg-accent/20 text-accent"
        : "text-gray-300 hover:bg-white/5 hover:text-white"
    }`;

  return (
    <div className="flex h-full flex-col overflow-y-auto py-2">
      {/* Project section */}
      <div className="px-2 pb-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Project
        </h3>
      </div>
      <button
        type="button"
        className={itemCls(isActive("project", "summary", "summary.md"))}
        onClick={() => onSelect({ scope: "project", type: "summary", name: "summary.md" })}
      >
        summary.md
      </button>
      {data.repoFiles.map((f) => (
        <button
          key={f.name}
          type="button"
          className={itemCls(isActive("project", "file", f.name))}
          onClick={() => onSelect({ scope: "project", type: "file", name: f.name })}
          title={f.name}
        >
          {f.name}
        </button>
      ))}
      {data.repoFiles.length === 0 && (
        <div className="px-2 py-1 text-[10px] italic text-muted">No memory files yet</div>
      )}

      {/* Global section */}
      <div className="mt-4 px-2 pb-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Global
        </h3>
      </div>
      <button
        type="button"
        className={itemCls(isActive("global", "summary", "summary.md"))}
        onClick={() => onSelect({ scope: "global", type: "summary", name: "summary.md" })}
      >
        summary.md
      </button>
      {data.homeFiles.map((f) => (
        <button
          key={f.name}
          type="button"
          className={itemCls(isActive("global", "file", f.name))}
          onClick={() => onSelect({ scope: "global", type: "file", name: f.name })}
          title={f.name}
        >
          {f.name}
        </button>
      ))}
      {data.homeFiles.length === 0 && (
        <div className="px-2 py-1 text-[10px] italic text-muted">No memory files yet</div>
      )}
    </div>
  );
}
