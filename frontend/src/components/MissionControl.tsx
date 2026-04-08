import { useEffect, useRef, useState } from "react";

type Props = {
  repo: string;
  rootTaskId: number | null;
  tick: number;
  provider: string;
  onSelectRepo: (repo: string) => void;
  onPickRepo: () => void;
  onOpenSettings: () => void;
  memoryOpen: boolean;
  onToggleMemory: () => void;
};

const PROVIDER_DOT: Record<string, string> = {
  claude: "bg-orange-400",
  codex: "bg-green-400",
  kimi: "bg-blue-400",
  mock: "bg-gray-400",
};

export function MissionControl({
  repo,
  rootTaskId,
  tick,
  provider,
  onSelectRepo,
  onPickRepo,
  onOpenSettings,
  memoryOpen,
  onToggleMemory,
}: Props) {
  const [rootTask, setRootTask] = useState<RootTaskRow | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootTaskId) { setRootTask(null); return; }
    void window.grist.getRootTask(rootTaskId).then((t) => setRootTask(t as RootTaskRow | null));
  }, [rootTaskId, tick]);

  useEffect(() => {
    if (dropdownOpen) {
      void window.grist.recentRepos().then(setRecentRepos);
    }
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [dropdownOpen]);

  const selectRepo = (r: string) => {
    setDropdownOpen(false);
    onSelectRepo(r);
  };

  const shortRepo = repo
    ? repo.split("/").slice(-2).join("/")
    : "repo…";

  return (
    <header className="flex items-center gap-2 border-b border-border/50 bg-[#0e1420] px-3 py-1.5 text-xs">
      <span className="text-sm font-semibold text-white">Grist</span>

      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          className="flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-muted hover:bg-white/5 hover:text-white"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          title={repo || "Pick repo"}
        >
          {shortRepo}
          <span className="text-[10px]">▾</span>
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[280px] max-w-[400px] rounded-lg border border-border bg-[#141a28] py-1 shadow-xl">
            {repo && (
              <div className="border-b border-border/40 px-3 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted">Current</div>
                <div className="truncate text-sm text-white" title={repo}>
                  {repo.replace(/^\/Users\/[^/]+/, "~")}
                </div>
              </div>
            )}

            {recentRepos.length > 0 && (
              <div className="max-h-48 overflow-auto py-1">
                <div className="px-3 py-0.5 text-[10px] uppercase tracking-wide text-muted">Recent</div>
                {recentRepos.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`flex w-full items-center truncate px-3 py-1 text-left text-sm hover:bg-white/10 ${
                      r === repo ? "text-accent" : "text-gray-300"
                    }`}
                    title={r}
                    onClick={() => selectRepo(r)}
                  >
                    {r.replace(/^\/Users\/[^/]+/, "~")}
                  </button>
                ))}
              </div>
            )}

            <div className="border-t border-border/40 pt-1">
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm text-muted hover:bg-white/10 hover:text-white"
                onClick={() => { setDropdownOpen(false); onPickRepo(); }}
              >
                Browse…
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-white/5 hover:text-white"
        onClick={onOpenSettings}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${PROVIDER_DOT[provider] ?? "bg-gray-500"}`} />
        {provider || "provider"}
      </button>

      <button
        type="button"
        className={`rounded px-1.5 py-0.5 text-xs ${
          memoryOpen
            ? "bg-accent/20 text-accent"
            : "text-muted hover:bg-white/5 hover:text-white"
        }`}
        onClick={onToggleMemory}
        title="Toggle memory drawer"
      >
        Memory
      </button>

      {rootTask && (
        <span className="text-muted">
          {rootTask.status} · {rootTask.total_tokens_used ?? 0} tok
        </span>
      )}

      {rootTaskId && (
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-amber-400 hover:bg-amber-900/30"
            onClick={() => void window.grist.rootTaskControl({ type: "pause_all", rootTaskId })}
            title="Pause all"
          >
            ⏸
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-emerald-400 hover:bg-emerald-900/30"
            onClick={() => void window.grist.rootTaskControl({ type: "resume_all", rootTaskId })}
            title="Resume all"
          >
            ▶
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-red-400 hover:bg-red-900/30"
            onClick={() => void window.grist.rootTaskControl({ type: "stop_run", rootTaskId })}
            title="Stop run"
          >
            ■
          </button>
        </div>
      )}
    </header>
  );
}
