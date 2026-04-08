import { useEffect, useState } from "react";

const NON_DISPLAY_KINDS = new Set(["root", "planner"]);

export function TaskList({
  repo,
  rootTaskId,
  tick,
  selectedId,
  onSelect,
  onLoadRootTask,
}: {
  repo: string;
  rootTaskId: number | null;
  tick: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onLoadRootTask: (rootTaskId: number) => void;
}) {
  const [allRootTasks, setAllRootTasks] = useState<RootTaskSummary[]>([]);
  const [childTasksByRoot, setChildTasksByRoot] = useState<Record<number, ChildTask[]>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    void window.grist.listRootTasks(repo || undefined).then((rows) => {
      setAllRootTasks(rows as RootTaskSummary[]);
    });
  }, [tick, repo]);

  useEffect(() => {
    if (rootTaskId) setExpanded((prev) => new Set(prev).add(rootTaskId));
  }, [rootTaskId]);

  useEffect(() => {
    for (const rid of expanded) {
      void window.grist.getChildTasks(rid).then((t) => {
        const tasks = (t as ChildTask[]).filter((c) => !NON_DISPLAY_KINDS.has(c.kind));
        setChildTasksByRoot((prev) => ({ ...prev, [rid]: tasks }));
      });
    }
  }, [expanded, tick]);

  const toggleExpand = (rid: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto text-xs">
      <h2 className="shrink-0 pb-1 font-semibold text-white">Tasks</h2>

      {allRootTasks.length === 0 && (
        <p className="text-muted">No tasks yet. Enter a goal and run.</p>
      )}

      {allRootTasks.map((rt) => {
        const isActive = rt.id === rootTaskId;
        const isExpanded = expanded.has(rt.id);
        const children = childTasksByRoot[rt.id] || [];

        return (
          <div key={rt.id} className="mb-0.5">
            <div
              className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 ${
                isActive ? "bg-accent/20 text-white" : "text-gray-300 hover:bg-white/5"
              }`}
              onClick={() => {
                if (!isActive) onLoadRootTask(rt.id);
                toggleExpand(rt.id);
              }}
              onKeyDown={(e) => e.key === "Enter" && toggleExpand(rt.id)}
              role="button"
              tabIndex={0}
            >
              <span className="text-[10px] text-muted">{isExpanded ? "▼" : "▶"}</span>
              <span className="flex-1 truncate">{rt.user_goal}</span>
              <StatusBadge status={rt.status} />
            </div>

            {isExpanded && (
              <div className="ml-3 border-l border-border/40 pl-1.5">
                <TaskTree
                  tasks={children}
                  parentId={null}
                  selectedId={selectedId}
                  onSelect={(id) => {
                    if (!isActive) onLoadRootTask(rt.id);
                    onSelect(id);
                  }}
                  depth={0}
                />
                {children.length === 0 && (
                  <p className="py-0.5 text-[10px] text-muted">No subtasks yet</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TaskTree({
  tasks,
  parentId,
  selectedId,
  onSelect,
  depth,
}: {
  tasks: ChildTask[];
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
  task: ChildTask;
  hasChildren: boolean;
  allTasks: ChildTask[];
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

function StatusBadge({ status }: { status: string }) {
  let cls = "bg-gray-700 text-gray-300";
  if (status === "running") cls = "bg-emerald-800 text-emerald-200";
  else if (status === "done" || status === "completed") cls = "bg-blue-800 text-blue-200";
  else if (status === "failed") cls = "bg-red-800 text-red-200";
  else if (status === "stopped") cls = "bg-gray-700 text-gray-300";
  return <span className={`shrink-0 rounded px-1 py-px text-[10px] ${cls}`}>{status}</span>;
}

function taskSublabel(t: ChildTask): string {
  const parts: string[] = [];
  if (t.steps_used > 0) parts.push(`${t.steps_used}/${t.max_steps}`);
  if (t.tokens_used > 0) parts.push(`${t.tokens_used} tok`);
  return parts.join(" · ") || t.kind;
}
