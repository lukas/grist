import React, { useCallback, useEffect, useState } from "react";
import { MissionControl } from "./components/MissionControl";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { NewTaskForm } from "./components/NewTaskForm";
import { SettingsModal } from "./components/SettingsModal";
import { SkillsModal } from "./components/SkillsModal";
import { RepoDialog } from "./components/RepoDialog";
import { AutoPauseBanner } from "./components/AutoPauseBanner";
import { MemoryDrawer } from "./components/MemoryDrawer";
import { MemoryViewer } from "./components/MemoryViewer";

class ModalErrorBoundary extends React.Component<
  { fallback: string; children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="rounded-lg border border-red-800 bg-[#1a2233] p-6 text-sm text-red-300">
            <p className="font-medium">{this.props.fallback} crashed:</p>
            <pre className="mt-2 text-xs text-red-400">{this.state.error}</pre>
            <button
              type="button"
              className="mt-3 rounded border border-border px-3 py-1 text-white"
              onClick={() => this.setState({ error: null })}
            >
              Dismiss
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [repo, setRepo] = useState("");
  const [rootTaskId, setRootTaskId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [pauseWarnings, setPauseWarnings] = useState<{ taskId: number; message: string }[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memorySel, setMemorySel] = useState<MemorySelection | null>(null);

  const refresh = useCallback(() => setTick((x) => x + 1), []);

  const loadProvider = useCallback(() => {
    void window.grist?.getSettings().then((raw) => {
      const o = raw as Record<string, unknown>;
      setProvider(String(o.defaultProvider ?? "mock"));
    });
  }, []);

  useEffect(() => { loadProvider(); }, [loadProvider]);

  useEffect(() => {
    void window.grist?.listRootTasks().then((rows) => {
      const tasks = rows as RootTaskSummary[];
      if (tasks.length > 0) {
        const latest = tasks[0];
        setRootTaskId(latest.id);
        setRepo(latest.repo_path);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.grist?.onEvent) return;
    const off = window.grist.onEvent((e) => {
      refresh();
      if (e.kind === "auto_pause" && e.taskId) {
        const msg = typeof e.data === "object" && e.data !== null
          ? (e.data as Record<string, unknown>).reason as string ?? "Agent auto-paused"
          : "Agent auto-paused";
        setPauseWarnings((prev) => [...prev, { taskId: e.taskId!, message: String(msg) }]);
      }
    });
    return off;
  }, [refresh]);

  if (typeof window !== "undefined" && !window.grist) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-panel p-6 text-center text-gray-100">
        <h1 className="text-lg font-semibold">Grist</h1>
        <p className="max-w-md text-sm text-muted">
          Preload did not expose <code className="text-accent">window.grist</code>. Check that{" "}
          <code className="text-accent">contextIsolation</code> is on and{" "}
          <code className="text-accent">preload.cjs</code> loaded next to the main bundle (CJS; ESM preload breaks here).
        </p>
      </div>
    );
  }

  useEffect(() => {
    if (!rootTaskId) return;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [rootTaskId, refresh]);

  const openRepoDialog = () => setRepoDialogOpen(true);

  const switchRepo = (repoPath: string) => {
    setRepo(repoPath);
    setRootTaskId(null);
    setSelectedTaskId(null);
  };

  const onRepoSelected = (repoPath: string) => {
    setRepo(repoPath);
    setRepoDialogOpen(false);
  };

  const startRun = async (goal: string) => {
    if (!repo) return;
    const id = await window.grist.createTask({ repoPath: repo, goal });
    setRootTaskId(id);
    await window.grist.startTask(id);
    refresh();
    // Auto-select the first child task once the planner creates one
    const selectFirst = async (retries: number) => {
      const children = await window.grist.getChildTasks(id) as ChildTask[];
      if (children.length > 0) {
        setSelectedTaskId(children[0].id);
      } else if (retries > 0) {
        setTimeout(() => void selectFirst(retries - 1), 500);
      }
    };
    void selectFirst(10);
  };

  const loadTask = (id: number) => {
    setRootTaskId(id);
    setSelectedTaskId(null);
    void window.grist.getRootTask(id).then((t) => {
      if (!t) return;
      const rt = t as RootTaskRow;
      if (rt.repo_path) setRepo(rt.repo_path);
    });
    refresh();
  };

  const dismissWarning = (idx: number) =>
    setPauseWarnings((prev) => prev.filter((_, i) => i !== idx));

  const selectMemory = (sel: MemorySelection) => {
    setMemorySel(sel);
    setSelectedTaskId(null);
  };

  const closeMemoryViewer = () => {
    setMemorySel(null);
  };

  const selectTask = (id: number | null) => {
    setSelectedTaskId(id);
    setMemorySel(null);
  };

  const showNewTaskForm = selectedTaskId == null && memorySel == null;

  return (
    <div className="flex h-screen flex-col bg-panel text-gray-100">
      <AutoPauseBanner
        warnings={pauseWarnings}
        onDismiss={dismissWarning}
        onDismissAll={() => setPauseWarnings([])}
      />
      <MissionControl
        repo={repo}
        rootTaskId={rootTaskId}
        tick={tick}
        provider={provider}
        onSelectRepo={switchRepo}
        onPickRepo={openRepoDialog}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSkills={() => setSkillsOpen(true)}
        memoryOpen={memoryOpen}
        onToggleMemory={() => setMemoryOpen((v) => !v)}
      />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-hidden border-r border-border/50 bg-panel p-2">
          <TaskList
            repo={repo}
            rootTaskId={rootTaskId}
            tick={tick}
            selectedId={selectedTaskId}
            onSelect={selectTask}
            onLoadRootTask={loadTask}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
          {memorySel ? (
            <MemoryViewer selection={memorySel} repo={repo} onClose={closeMemoryViewer} />
          ) : showNewTaskForm ? (
            <NewTaskForm
              repo={repo}
              onCreateRun={startRun}
              onPickRepo={openRepoDialog}
            />
          ) : (
            <TaskDetail rootTaskId={rootTaskId} taskId={selectedTaskId} tick={tick} onRefresh={refresh} />
          )}
        </div>
        {memoryOpen && repo && (
          <div className="w-56 shrink-0 overflow-hidden border-l border-border/50 bg-[#0e1420]">
            <MemoryDrawer
              repo={repo}
              tick={tick}
              selected={memorySel}
              onSelect={selectMemory}
            />
          </div>
        )}
      </div>
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); loadProvider(); }} />}
      {skillsOpen && (
        <ModalErrorBoundary fallback="Skills">
          <SkillsModal repo={repo} onClose={() => setSkillsOpen(false)} />
        </ModalErrorBoundary>
      )}
      {repoDialogOpen && (
        <RepoDialog
          onSelect={onRepoSelected}
          onCancel={() => setRepoDialogOpen(false)}
        />
      )}
    </div>
  );
}
