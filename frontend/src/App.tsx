import { useCallback, useEffect, useState } from "react";
import { MissionControl } from "./components/MissionControl";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { SettingsModal } from "./components/SettingsModal";
import { RepoDialog } from "./components/RepoDialog";
import { AutoPauseBanner } from "./components/AutoPauseBanner";

export default function App() {
  const [repo, setRepo] = useState("");
  const [goal, setGoal] = useState("");
  const [notes, setNotes] = useState("");
  const [rootTaskId, setRootTaskId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [pendingRun, setPendingRun] = useState(false);
  const [provider, setProvider] = useState("");
  const [pauseWarnings, setPauseWarnings] = useState<{ taskId: number; message: string }[]>([]);

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
        setGoal(latest.user_goal);
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
    setGoal("");
    setNotes("");
  };

  const onRepoSelected = (repoPath: string) => {
    setRepo(repoPath);
    setRepoDialogOpen(false);
    if (pendingRun && goal.trim()) {
      setPendingRun(false);
      void startRun(repoPath);
    }
  };

  const startRun = async (repoPath: string) => {
    const id = await window.grist.createTask({ repoPath, goal: goal.trim(), notes });
    setRootTaskId(id);
    await window.grist.startTask(id);
    refresh();
  };

  const loadTask = (id: number) => {
    setRootTaskId(id);
    setSelectedTaskId(null);
    void window.grist.getRootTask(id).then((t) => {
      if (!t) return;
      const rt = t as RootTaskRow;
      if (rt.repo_path) setRepo(rt.repo_path);
      if (rt.user_goal) setGoal(rt.user_goal);
      if (rt.operator_notes) setNotes(rt.operator_notes);
    });
    refresh();
  };

  const createAndPlan = async () => {
    if (!goal.trim()) return;
    if (!repo) {
      setPendingRun(true);
      setRepoDialogOpen(true);
      return;
    }
    await startRun(repo);
  };

  const dismissWarning = (idx: number) =>
    setPauseWarnings((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div className="flex h-screen flex-col bg-panel text-gray-100">
      <AutoPauseBanner
        warnings={pauseWarnings}
        onDismiss={dismissWarning}
        onDismissAll={() => setPauseWarnings([])}
      />
      <MissionControl
        repo={repo}
        goal={goal}
        rootTaskId={rootTaskId}
        tick={tick}
        onGoalChange={setGoal}
        onNotesChange={setNotes}
        notes={notes}
        onSelectRepo={switchRepo}
        onPickRepo={openRepoDialog}
        onCreateRun={createAndPlan}
        provider={provider}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-hidden border-r border-border/50 bg-panel p-2">
          <TaskList
            repo={repo}
            rootTaskId={rootTaskId}
            tick={tick}
            selectedId={selectedTaskId}
            onSelect={setSelectedTaskId}
            onLoadRootTask={loadTask}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
          <TaskDetail rootTaskId={rootTaskId} taskId={selectedTaskId} tick={tick} onRefresh={refresh} />
        </div>
      </div>
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); loadProvider(); }} />}
      {repoDialogOpen && (
        <RepoDialog
          onSelect={onRepoSelected}
          onCancel={() => { setRepoDialogOpen(false); setPendingRun(false); }}
        />
      )}
    </div>
  );
}
