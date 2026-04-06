import { useCallback, useEffect, useState } from "react";
import { MissionControl } from "./components/MissionControl";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { GlobalFindings } from "./components/GlobalFindings";
import { EventStream } from "./components/EventStream";
import { PatchComparison } from "./components/PatchComparison";
import { SettingsModal } from "./components/SettingsModal";

export default function App() {
  const [repo, setRepo] = useState("");
  const [goal, setGoal] = useState("");
  const [notes, setNotes] = useState("");
  const [jobId, setJobId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"table" | "dag">("table");

  const refresh = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    if (!window.grist?.onEvent) return;
    const off = window.grist.onEvent(() => refresh());
    return off;
  }, [refresh]);

  if (typeof window !== "undefined" && !window.grist) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-panel p-6 text-center text-gray-100">
        <h1 className="text-lg font-semibold">Swarm Operator</h1>
        <p className="max-w-md text-sm text-muted">
          Preload did not expose <code className="text-accent">window.grist</code>. Check that{" "}
          <code className="text-accent">contextIsolation</code> is on and{" "}
          <code className="text-accent">preload.js</code> loaded next to the main bundle.
        </p>
      </div>
    );
  }

  useEffect(() => {
    if (!jobId) return;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [jobId, refresh]);

  const pickRepo = async () => {
    const p = await window.grist.pickRepo();
    if (p) setRepo(p);
  };

  const createAndPlan = async () => {
    if (!repo || !goal.trim()) return;
    const id = await window.grist.createJob({ repoPath: repo, goal: goal.trim(), operatorNotes: notes });
    setJobId(id);
    await window.grist.runPlanner(id);
    await window.grist.startScheduler(id);
    refresh();
  };

  return (
    <div className="flex h-screen flex-col bg-panel text-gray-100">
      <MissionControl
        repo={repo}
        goal={goal}
        jobId={jobId}
        tick={tick}
        onGoalChange={setGoal}
        onNotesChange={setNotes}
        notes={notes}
        onPickRepo={pickRepo}
        onCreateRun={createAndPlan}
        onOpenSettings={() => setSettingsOpen(true)}
        view={view}
        onViewChange={setView}
      />
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-px bg-border">
        <div className="col-span-3 flex min-h-0 flex-col overflow-hidden bg-panel p-2">
          <TaskList
            jobId={jobId}
            tick={tick}
            selectedId={selectedTaskId}
            onSelect={setSelectedTaskId}
            view={view}
            onRefresh={refresh}
          />
        </div>
        <div className="col-span-5 flex min-h-0 flex-col overflow-hidden bg-panel p-2">
          <TaskDetail jobId={jobId} taskId={selectedTaskId} tick={tick} onRefresh={refresh} />
        </div>
        <div className="col-span-4 flex min-h-0 flex-col gap-2 overflow-hidden bg-panel p-2">
          <GlobalFindings jobId={jobId} tick={tick} />
          <PatchComparison jobId={jobId} tick={tick} />
        </div>
      </div>
      <div className="h-40 border-t border-border bg-panel p-2">
        <EventStream jobId={jobId} tick={tick} />
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
