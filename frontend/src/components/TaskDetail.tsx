import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
function safeJson(s: string): Record<string, any> | null {
  try { return JSON.parse(s) as Record<string, any>; } catch { return null; }
}

export function TaskDetail({
  rootTaskId,
  taskId,
  tick,
}: {
  rootTaskId: number | null;
  taskId: number | null;
  tick: number;
  onRefresh: () => void;
}) {
  const [task, setTask] = useState<ChildTask | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (taskId == null || !rootTaskId) {
      setTask(null);
      setEvents([]);
      return;
    }
    void window.grist.getChildTasks(rootTaskId).then((rows) => {
      setTask((rows as ChildTask[]).find((r) => r.id === taskId) || null);
    });
    void window.grist.getEventsForTask(taskId).then((rows) =>
      setEvents(rows as TaskEvent[]),
    );
  }, [rootTaskId, taskId, tick]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const steps = useMemo(() => groupByStep(events), [events]);

  const [msgInput, setMsgInput] = useState("");
  const [sending, setSending] = useState(false);

  const sendMessage = useCallback(async () => {
    const text = msgInput.trim();
    if (!text || !taskId) return;
    setSending(true);
    try {
      await window.grist.sendTaskMessage(taskId, text);
      setMsgInput("");
    } finally {
      setSending(false);
    }
  }, [msgInput, taskId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  if (taskId == null) {
    return <p className="p-4 text-sm text-muted">Select a task to see its activity.</p>;
  }
  if (!task) return <p className="p-4 text-sm">Loading…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-1.5 text-xs">
        <span className="font-medium text-white">{task.role}</span>
        <StatusPill status={task.status} />
        {task.status === "running" && task.current_action && (
          <ActivityBadge action={task.current_action} />
        )}
        {(task.status === "paused" || task.status === "stopped") && rootTaskId && (
          <button
            type="button"
            className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-600"
            onClick={() => {
              void window.grist.taskControl({ type: "enqueue", taskId: task.id });
              void window.grist.rootTaskControl({ type: "resume_all", rootTaskId });
            }}
          >
            ▶ Resume
          </button>
        )}
        <span className="text-muted">
          {task.steps_used}/{task.max_steps} steps
        </span>
        <span className="text-muted">{task.tokens_used} tok</span>
        {rootTaskId && (
          <button
            type="button"
            className="ml-auto text-[10px] text-muted hover:text-white"
            onClick={() => void window.grist.logsDir(rootTaskId).then((d) => window.grist.openPath(d))}
          >
            logs
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
        {steps.length === 0 && <p className="text-xs text-muted">No activity yet.</p>}
        {steps.map((step) => (
          <StepBlock key={step.key} step={step} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border/50 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[36px] max-h-24 flex-1 resize-none rounded border border-border/60 bg-white/5 px-2.5 py-1.5 text-sm text-white placeholder:text-muted focus:border-violet-500/60 focus:outline-none"
            placeholder="Send a message to this agent… (⌘+Enter)"
            value={msgInput}
            onChange={(e) => setMsgInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            type="button"
            disabled={!msgInput.trim() || sending}
            className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            onClick={() => void sendMessage()}
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Step grouping ── */

type StepGroup = {
  key: string;
  stepNum: number | null;
  reasoning: string;
  decision: string;
  tokensIn: number;
  tokensOut: number;
  toolName: string;
  toolArgs: any;
  toolResult: any;
  toolOk: boolean;
  promptData: any;
  rawResponse: string;
  genericEvents: TaskEvent[];
  time: string;
};

function groupByStep(events: TaskEvent[]): StepGroup[] {
  const map = new Map<string, StepGroup>();
  const order: string[] = [];

  for (const ev of events) {
    const data = ev.data_json ? safeJson(ev.data_json) : null;
    const stepNum = data?.step as number | undefined;
    const key = stepNum != null ? `step-${stepNum}` : `ev-${ev.id}`;

    if (!map.has(key)) {
      map.set(key, {
        key,
        stepNum: stepNum ?? null,
        reasoning: "",
        decision: "",
        tokensIn: 0,
        tokensOut: 0,
        toolName: "",
        toolArgs: null,
        toolResult: null,
        toolOk: true,
        promptData: null,
        rawResponse: "",
        genericEvents: [],
        time: ev.created_at.slice(11, 19),
      });
      order.push(key);
    }

    const g = map.get(key)!;

    if (ev.type === "prompt") {
      g.promptData = data;
    } else if (ev.type === "model_response") {
      g.reasoning = data?.reasoning || "";
      g.decision = data?.decision || "";
      g.tokensIn = data?.tokensIn ?? 0;
      g.tokensOut = data?.tokensOut ?? 0;
      g.rawResponse = data?.raw || "";
    } else if (ev.type === "tool_call") {
      g.toolName = data?.tool_name || ev.message;
      g.toolArgs = data?.tool_args;
    } else if (ev.type === "tool_result") {
      g.toolResult = data?.result ?? ev.message;
      g.toolName = g.toolName || data?.tool_name || "";
      const resultObj = typeof g.toolResult === "object" && g.toolResult;
      g.toolOk = resultObj ? resultObj.ok !== false : true;
    } else {
      g.genericEvents.push(ev);
    }
  }

  return order.map((k) => map.get(k)!);
}

/* ── One step rendered ── */

function StepBlock({ step }: { step: StepGroup }) {
  const [expanded, setExpanded] = useState(false);

  if (!step.reasoning && !step.toolName && step.genericEvents.length > 0) {
    return (
      <>
        {step.genericEvents.map((ev) => (
          <GenericLine key={ev.id} ev={ev} />
        ))}
      </>
    );
  }

  if (!step.reasoning && !step.toolName) return null;

  const toolSummary = step.toolName ? summarizeTool(step.toolName, step.toolArgs, step.toolResult) : "";

  return (
    <div className="mb-3">
      {step.reasoning && (
        <div className="flex items-start gap-2">
          <p className="flex-1 text-[11px] leading-relaxed text-gray-500">{step.reasoning}</p>
          <span className="shrink-0 pt-0.5 text-[10px] text-gray-600">{step.time}</span>
        </div>
      )}

      {step.toolName && (
        <div className="mt-1">
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] hover:bg-white/5"
            onClick={() => setExpanded(!expanded)}
          >
            <span className={step.toolOk ? "text-emerald-400" : "text-red-400"}>
              {step.toolOk ? "✓" : "✗"}
            </span>
            <span className="font-mono text-gray-500">{step.toolName}</span>
            {toolSummary && (
              <span className="truncate text-muted">{toolSummary}</span>
            )}
            {(step.tokensIn > 0) && (
              <span className="ml-auto shrink-0 text-[10px] text-gray-600">
                {step.tokensIn}→{step.tokensOut}
              </span>
            )}
            {!step.reasoning && (
              <span className="shrink-0 text-[10px] text-gray-600">{step.time}</span>
            )}
            <span className="shrink-0 text-[10px] text-muted opacity-0 group-hover:opacity-100">
              {expanded ? "▲" : "▼"}
            </span>
          </button>

          {expanded && (
            <div className="ml-5 mt-1 space-y-1 border-l border-border/30 pl-3 text-[11px]">
              {step.toolArgs && (
                <div>
                  <div className="text-[10px] text-muted">args</div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-gray-400">
                    {JSON.stringify(step.toolArgs, null, 2)}
                  </pre>
                </div>
              )}
              {step.toolResult && (
                <div>
                  <div className="text-[10px] text-muted">result</div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-gray-400">
                    {typeof step.toolResult === "string"
                      ? step.toolResult
                      : JSON.stringify(step.toolResult, null, 2)}
                  </pre>
                </div>
              )}
              {step.promptData && (
                <div>
                  <div className="text-[10px] text-muted">prompt</div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-gray-500">
                    {step.promptData.user}
                  </pre>
                </div>
              )}
              {step.rawResponse && (
                <div>
                  <div className="text-[10px] text-muted">raw response</div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-gray-500">
                    {step.rawResponse}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {step.genericEvents.map((ev) => (
        <GenericLine key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

function GenericLine({ ev }: { ev: TaskEvent }) {
  const [expanded, setExpanded] = useState(false);
  const data = ev.data_json ? safeJson(ev.data_json) : null;
  const time = ev.created_at.slice(11, 19);

  if (ev.type === "user_message") {
    return (
      <div className="my-1.5 flex items-start gap-2 rounded border border-border/40 bg-white/[0.03] px-3 py-2">
        <span className="flex-1 text-sm text-gray-200">{ev.message}</span>
        <span className="shrink-0 text-[10px] text-gray-600">{time}</span>
      </div>
    );
  }

  if (ev.type === "task_done" || ev.type === "task_failed") {
    const ok = ev.type === "task_done";
    return (
      <div className="my-1.5">
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
            ok ? "bg-blue-900/20 text-blue-300" : "bg-red-900/20 text-red-300"
          }`}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{ok ? "Task completed" : "Task failed"}</span>
          <span className="ml-auto shrink-0 text-[10px] text-gray-600">{time}</span>
          <span className="shrink-0 text-[10px] text-muted">{expanded ? "▲" : "▼"}</span>
        </button>
        {expanded && ev.message && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/20 px-3 py-2 text-[11px] text-gray-400">
            {ev.message}
          </pre>
        )}
      </div>
    );
  }

  const color =
    ev.level === "error" ? "text-red-400" :
    ev.level === "warn" ? "text-amber-300" :
    "text-gray-500";

  return (
    <div className={`flex items-start gap-1 py-0.5 text-xs ${color}`}>
      <span className="font-medium">[{ev.type}]</span>
      <span className="flex-1">{ev.message}</span>
      {data && (
        <button
          type="button"
          className="shrink-0 text-[10px] text-muted hover:text-white"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "−" : "+"}
        </button>
      )}
      <span className="shrink-0 text-[10px] text-gray-600">{time}</span>
      {expanded && data && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ── Tool summarizer ── */

function summarizeTool(name: string, args: any, result: any): string {
  const r = typeof result === "object" && result ? result : {};
  const d = r.data || r;
  const ok = r.ok !== false;

  switch (name) {
    case "write_file":
      return args?.path ? `→ ${args.path}` : "";
    case "read_file":
      return args?.path
        ? `${args.path}${d.totalLines ? ` (${d.totalLines} lines)` : ""}`
        : "";
    case "list_files": {
      const files = d.files as string[] | undefined;
      return files ? `${files.length} file${files.length !== 1 ? "s" : ""}` : "";
    }
    case "grep_code":
      return args?.pattern ? `"${args.pattern}"` : "";
    case "run_command_safe":
      return args?.command ? args.command.slice(0, 60) : "";
    case "apply_patch":
      return args?.patch_path || args?.path || "";
    default:
      if (!ok && r.error) return String(r.error).slice(0, 60);
      return "";
  }
}

function StatusPill({ status }: { status: string }) {
  let cls = "bg-gray-700 text-gray-300";
  if (status === "running") cls = "bg-emerald-800/60 text-emerald-300";
  else if (status === "done" || status === "completed") cls = "bg-blue-800/60 text-blue-300";
  else if (status === "failed") cls = "bg-red-800/60 text-red-300";
  else if (status === "paused") cls = "bg-amber-800/60 text-amber-300";
  return <span className={`rounded-full px-1.5 py-px text-[10px] ${cls}`}>{status}</span>;
}

function ActivityBadge({ action }: { action: string }) {
  let label: string;
  let cls: string;
  if (action === "thinking") {
    label = "Waiting for LLM…";
    cls = "border-violet-500/40 text-violet-300 bg-violet-900/20";
  } else if (action.startsWith("step ")) {
    label = "Running tool…";
    cls = "border-cyan-500/40 text-cyan-300 bg-cyan-900/20";
  } else if (action === "worker_start") {
    label = "Starting…";
    cls = "border-gray-500/40 text-gray-300 bg-gray-900/20";
  } else {
    label = action;
    cls = "border-gray-500/40 text-gray-300 bg-gray-900/20";
  }
  return (
    <span className={`inline-flex animate-pulse items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${cls}`}>
      <span className="inline-block h-1 w-1 rounded-full bg-current" />
      {label}
    </span>
  );
}
