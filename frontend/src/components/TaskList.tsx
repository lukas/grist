import { useEffect, useState } from "react";

type Task = {
  id: number;
  role: string;
  kind: string;
  status: string;
  assigned_model_provider: string;
  confidence: number;
  tokens_used: number;
  steps_used: number;
  max_steps: number;
  workspace_repo_mode: string;
  goal: string;
  findings_json: string;
  dependencies_json: string;
  parent_task_id: number | null;
  blocker: string;
};

type JobSummary = {
  id: number;
  user_goal: string;
  status: string;
  repo_path: string;
  created_at: string;
};

/* Sentinel IDs for virtual nodes */
const PLANNER_OFFSET = -1_000_000;
const plannerIdFor = (jobId: number) => PLANNER_OFFSET - jobId;
const isPlannerNode = (id: number) => id <= PLANNER_OFFSET;
const jobIdFromPlanner = (id: number) => -(id - PLANNER_OFFSET);

export { isPlannerNode, jobIdFromPlanner };

export function TaskList({
  jobId,
  tick,
  selectedId,
  onSelect,
  onLoadJob,
}: {
  jobId: number | null;
  tick: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onLoadJob: (jobId: number) => void;
}) {
  const [allJobs, setAllJobs] = useState<JobSummary[]>([]);
  const [tasksByJob, setTasksByJob] = useState<Record<number, Task[]>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Load all jobs
  useEffect(() => {
    void window.grist.listJobs().then((rows) => {
      const jobs = (rows as JobSummary[]).slice().reverse();
      setAllJobs(jobs);
    });
  }, [tick]);

  // Auto-expand current job
  useEffect(() => {
    if (jobId) setExpanded((prev) => new Set(prev).add(jobId));
  }, [jobId]);

  // Load tasks for expanded jobs
  useEffect(() => {
    for (const jid of expanded) {
      void window.grist.getTasks(jid).then((t) => {
        setTasksByJob((prev) => ({ ...prev, [jid]: t as Task[] }));
      });
    }
  }, [expanded, tick]);

  const toggleExpand = (jid: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(jid)) next.delete(jid);
      else next.add(jid);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto text-xs">
      <h2 className="shrink-0 pb-1 font-semibold text-white">Jobs &amp; Tasks</h2>

      {allJobs.length === 0 && (
        <p className="text-muted">No jobs yet. Enter a goal and run.</p>
      )}

      {allJobs.map((job) => {
        const isActive = job.id === jobId;
        const isExpanded = expanded.has(job.id);
        const tasks = tasksByJob[job.id] || [];

        return (
          <div key={job.id} className="mb-0.5">
            {/* Job header */}
            <div
              className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 ${
                isActive ? "bg-accent/20 text-white" : "text-gray-300 hover:bg-white/5"
              }`}
              onClick={() => {
                if (!isActive) onLoadJob(job.id);
                toggleExpand(job.id);
              }}
              onKeyDown={(e) => e.key === "Enter" && toggleExpand(job.id)}
              role="button"
              tabIndex={0}
            >
              <span className="text-[10px] text-muted">{isExpanded ? "▼" : "▶"}</span>
              <span className="font-medium">#{job.id}</span>
              <span className="flex-1 truncate">{job.user_goal}</span>
              <JobBadge status={job.status} />
            </div>

            {/* Nested children */}
            {isExpanded && (
              <div className="ml-3 border-l border-border/40 pl-1.5">
                {/* Planner node */}
                <TreeNode
                  label="Planner"
                  sublabel="job-level"
                  status={job.status === "completed" ? "done" : job.status}
                  isSelected={selectedId === plannerIdFor(job.id)}
                  onClick={() => {
                    if (!isActive) onLoadJob(job.id);
                    onSelect(plannerIdFor(job.id));
                  }}
                  depth={0}
                />

                {/* Task tree */}
                <TaskTree
                  tasks={tasks}
                  parentId={null}
                  selectedId={selectedId}
                  onSelect={(id) => {
                    if (!isActive) onLoadJob(job.id);
                    onSelect(id);
                  }}
                  depth={0}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Recursively render tasks that share a parentId */
function TaskTree({
  tasks,
  parentId,
  selectedId,
  onSelect,
  depth,
}: {
  tasks: Task[];
  parentId: number | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  depth: number;
}) {
  const children = tasks.filter((t) => t.parent_task_id === parentId);
  if (children.length === 0) return null;

  return (
    <>
      {children.map((t) => {
        const hasChildren = tasks.some((c) => c.parent_task_id === t.id);
        return (
          <TaskNode
            key={t.id}
            task={t}
            hasChildren={hasChildren}
            allTasks={tasks}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth}
          />
        );
      })}
    </>
  );
}

function TaskNode({
  task,
  hasChildren,
  allTasks,
  selectedId,
  onSelect,
  depth,
}: {
  task: Task;
  hasChildren: boolean;
  allTasks: Task[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  const isSelected = selectedId === task.id;

  return (
    <div>
      <TreeNode
        label={task.role}
        sublabel={taskSublabel(task)}
        status={task.status}
        isSelected={isSelected}
        hasToggle={hasChildren}
        isOpen={open}
        onToggle={() => setOpen(!open)}
        onClick={() => onSelect(task.id)}
        depth={depth}
        blocker={task.blocker}
      />
      {hasChildren && open && (
        <div className="ml-3 border-l border-border/30 pl-1">
          <TaskTree
            tasks={allTasks}
            parentId={task.id}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
}

function TreeNode({
  label,
  sublabel,
  status,
  isSelected,
  onClick,
  hasToggle,
  isOpen,
  onToggle,
  depth: _depth,
  blocker,
}: {
  label: string;
  sublabel?: string;
  status: string;
  isSelected: boolean;
  onClick: () => void;
  hasToggle?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  depth: number;
  blocker?: string;
}) {
  return (
    <div
      className={`my-px flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ${
        isSelected ? "bg-accent/30 text-white" : "text-gray-300 hover:bg-white/5"
      }`}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      role="button"
      tabIndex={0}
    >
      {hasToggle ? (
        <span
          className="text-[10px] text-muted"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
        >
          {isOpen ? "▼" : "▶"}
        </span>
      ) : (
        <span className="w-2.5" />
      )}
      <StatusDot status={status} />
      <span className="flex-1 truncate font-medium">{label}</span>
      {sublabel && <span className="shrink-0 text-[10px] text-muted">{sublabel}</span>}
      {blocker && <span className="shrink-0 truncate text-[10px] text-red-400" title={blocker}>!</span>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  let color = "bg-gray-500";
  if (status === "running") color = "bg-emerald-400 animate-pulse";
  else if (status === "done" || status === "completed") color = "bg-blue-400";
  else if (status === "failed") color = "bg-red-400";
  else if (status === "paused") color = "bg-amber-400";
  else if (status === "queued" || status === "ready") color = "bg-gray-400";
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}

function JobBadge({ status }: { status: string }) {
  let cls = "bg-gray-700 text-gray-300";
  if (status === "running") cls = "bg-emerald-800 text-emerald-200";
  else if (status === "completed") cls = "bg-blue-800 text-blue-200";
  else if (status === "failed") cls = "bg-red-800 text-red-200";
  else if (status === "stopped") cls = "bg-gray-700 text-gray-300";
  return <span className={`shrink-0 rounded px-1 py-px text-[10px] ${cls}`}>{status}</span>;
}

function taskSublabel(t: Task): string {
  const parts: string[] = [];
  if (t.steps_used > 0) parts.push(`${t.steps_used}/${t.max_steps}`);
  if (t.tokens_used > 0) parts.push(`${t.tokens_used} tok`);
  return parts.join(" · ") || t.kind;
}
