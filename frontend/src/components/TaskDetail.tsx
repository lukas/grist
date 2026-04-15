import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
function safeJson(s: string): Record<string, any> | null {
  try { return JSON.parse(s) as Record<string, any>; } catch { return null; }
}

export function TaskDetail({
  rootTaskId,
  taskId,
  tick,
  onSelectTask,
}: {
  rootTaskId: number | null;
  taskId: number | null;
  tick: number;
  onRefresh: () => void;
  onSelectTask: (taskId: number) => void;
}) {
  const [task, setTask] = useState<ChildTask | null>(null);
  const [allTasks, setAllTasks] = useState<ChildTask[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (taskId == null || !rootTaskId) {
      setTask(null);
      setEvents([]);
      return;
    }
    void window.grist.getChildTasks(rootTaskId).then((rows) => {
      const typedRows = rows as ChildTask[];
      setAllTasks(typedRows);
      setTask(typedRows.find((r) => r.id === taskId) || null);
    });
    void window.grist.getEventsForTask(taskId).then((rows) =>
      setEvents(rows as TaskEvent[]),
    );
  }, [rootTaskId, taskId, tick]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const steps = useMemo(() => groupByStep(events), [events]);
  const episodeTasks = useMemo(() => {
    if (!task?.episode_root_task_id) return task ? [task] : [];
    return allTasks
      .filter((candidate) => candidate.episode_root_task_id === task.episode_root_task_id)
      .sort((a, b) => a.id - b.id);
  }, [allTasks, task]);

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
  const runtime = safeJson(task.runtime_json);
  const runtimeUrl = Array.isArray(runtime?.serviceUrls) && runtime.serviceUrls[0]
    ? String(runtime.serviceUrls[0])
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-1.5 text-xs">
        <span className="font-medium text-white">{taskDisplayLabel(task)}</span>
        <StatusPill status={task.status} />
        {task.episode_label && (
          <span className="rounded bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-300">
            {task.episode_label}
          </span>
        )}
        {task.episode_phase && (
          <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted">
            {phaseLabel(task.episode_phase)}
            {task.episode_attempt != null ? ` · attempt ${task.episode_attempt}` : ""}
          </span>
        )}
        {task.status === "running" && task.current_action && (
          <ActivityBadge action={task.current_action} />
        )}
        {task.git_branch && (
          <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted">
            {task.git_branch}
          </span>
        )}
        {runtime?.mode === "docker" && (
          <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-300">
            docker:{runtime.status}
          </span>
        )}
        {runtimeUrl && (
          <span className="truncate text-[10px] text-muted">
            {runtimeUrl}
          </span>
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
      {episodeTasks.length > 1 && (
        <div className="shrink-0 border-b border-border/40 bg-white/[0.02] px-4 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Episode flow</div>
          <div className="flex flex-wrap gap-1.5">
            {episodeTasks.map((episodeTask) => (
              <button
                key={episodeTask.id}
                type="button"
                className={`rounded px-2 py-1 text-[11px] ${
                  episodeTask.id === task.id
                    ? "bg-accent/30 text-white"
                    : "bg-white/5 text-gray-300 hover:bg-white/10"
                }`}
                onClick={() => onSelectTask(episodeTask.id)}
              >
                {taskDisplayLabel(episodeTask)}
                <span className="ml-1 text-[10px] text-muted">
                  {episodeTask.status}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

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

type DiffSummary = {
  kind: "diff" | "patch";
  files: string[];
  fileCount: number;
  insertions: number | null;
  deletions: number | null;
  rawText: string;
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

  const diffSummary = summarizeDiffPayload(step.toolResult);
  const toolSummary = step.toolName ? summarizeTool(step.toolName, step.toolArgs, step.toolResult) : "";
  const compactSummary = diffSummary ? formatDiffHeadline(diffSummary) : toolSummary;
  const compactFiles = diffSummary ? formatDiffFiles(diffSummary) : "";

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
            className="group flex w-full items-start gap-1.5 rounded px-2 py-1 text-left text-[11px] hover:bg-white/5"
            onClick={() => setExpanded(!expanded)}
          >
            <span className={step.toolOk ? "text-emerald-400" : "text-red-400"}>
              {step.toolOk ? "✓" : "✗"}
            </span>
            <span className="font-mono text-gray-500">{step.toolName}</span>
            <div className="min-w-0 flex-1">
              {compactSummary && (
                <div className="truncate text-muted">{compactSummary}</div>
              )}
              {compactFiles && (
                <div className="mt-0.5 truncate text-[10px] text-gray-500">{compactFiles}</div>
              )}
            </div>
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
                <PayloadBlock label="args" value={step.toolArgs} />
              )}
              {step.toolResult && (
                <PayloadBlock label="result" value={step.toolResult} />
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
  const messageDiff = summarizeDiffPayload(ev.message);
  const eventDetails = data ?? ev.message;
  const compactMessage = messageDiff ? formatDiffHeadline(messageDiff) : truncateText(ev.message, 240);
  const compactFiles = messageDiff ? formatDiffFiles(messageDiff) : "";

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

  if (ev.type === "task_diff") {
    const diffText = typeof ev.message === "string" ? normalizeDiffText(ev.message) : "";
    const diffSummary = summarizeDiffPayload(diffText || data || ev.message);
    return (
      <div className="my-1.5">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded border border-border/40 bg-white/[0.03] px-2.5 py-1.5 text-left text-xs text-gray-300 hover:bg-white/[0.05]"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="font-medium text-gray-200">
            {diffSummary ? formatDiffHeadline(diffSummary) : "Task diff available"}
          </span>
          {diffSummary && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500">
              {formatDiffFiles(diffSummary)}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-gray-600">{time}</span>
          <span className="shrink-0 text-[10px] text-muted">{expanded ? "▲" : "▼"}</span>
        </button>
        {expanded && (
          <div className="mt-1">
            {diffSummary ? (
              <DiffPayload summary={diffSummary} />
            ) : (
              <PayloadBlock label="diff" value={diffText || ev.message} />
            )}
          </div>
        )}
      </div>
    );
  }

  const color =
    ev.level === "error" ? "text-red-400" :
    ev.level === "warn" ? "text-amber-300" :
    "text-gray-500";

  return (
    <div className="py-0.5">
      <div className={`flex items-start gap-1 text-xs ${color}`}>
        <span className="font-medium">[{ev.type}]</span>
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words">{compactMessage}</div>
          {compactFiles && (
            <div className="mt-0.5 text-[10px] text-gray-500">{compactFiles}</div>
          )}
        </div>
        {(data || messageDiff || ev.message.length > 240) && (
          <button
            type="button"
            className="shrink-0 text-[10px] text-muted hover:text-white"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "−" : "+"}
          </button>
        )}
        <span className="shrink-0 text-[10px] text-gray-600">{time}</span>
      </div>
      {expanded && (
        <div className="ml-5 mt-1 border-l border-border/30 pl-3">
          <PayloadBlock label="details" value={eventDetails} />
        </div>
      )}
    </div>
  );
}

/* ── Tool summarizer ── */

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const diffSummary = summarizeDiffPayload(value);
  const text = valueToText(value);

  return (
    <div>
      <div className="text-[10px] text-muted">{label}</div>
      {diffSummary ? (
        <DiffPayload summary={diffSummary} />
      ) : (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/20 px-3 py-2 text-gray-400">
          {text}
        </pre>
      )}
    </div>
  );
}

function DiffPayload({ summary }: { summary: DiffSummary }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="mt-1 rounded border border-border/40 bg-white/[0.03] px-3 py-2">
      <div className="text-[11px] text-gray-200">{formatDiffHeadline(summary)}</div>
      {summary.files.length > 0 && (
        <div className="mt-1 text-[10px] text-gray-500">{formatDiffFiles(summary, 8)}</div>
      )}
      <button
        type="button"
        className="mt-2 text-[10px] text-muted hover:text-white"
        onClick={() => setShowRaw((v) => !v)}
      >
        {showRaw ? "Hide raw diff" : "Show raw diff"}
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/20 px-3 py-2 text-gray-400">
          {summary.rawText}
        </pre>
      )}
    </div>
  );
}

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
    case "apply_patch": {
      const diffSummary = summarizeDiffPayload(result);
      return diffSummary
        ? formatDiffHeadline(diffSummary)
        : (args?.patch_path || args?.path || "");
    }
    default:
      if (!ok && r.error) return String(r.error).slice(0, 60);
      return "";
  }
}

function summarizeDiffPayload(value: unknown): DiffSummary | null {
  for (const text of extractCandidateTexts(value)) {
    const summary = parseDiffText(normalizeDiffText(text));
    if (summary) return summary;
  }
  return null;
}

function extractCandidateTexts(value: unknown): string[] {
  const out: string[] = [];
  const push = (text: unknown) => {
    if (typeof text === "string" && text.trim()) out.push(text);
  };

  push(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    push(obj.message);
    push(obj.stdout);
    push(obj.stderr);
    push(obj.diff);
    push(obj.patch);
    push(obj.lines);
    if (obj.data && typeof obj.data === "object") {
      const data = obj.data as Record<string, unknown>;
      push(data.message);
      push(data.stdout);
      push(data.stderr);
      push(data.diff);
      push(data.patch);
      push(data.lines);
    }
    push(valueToText(value));
  }

  return [...new Set(out)];
}

function parseDiffText(text: string): DiffSummary | null {
  const looksLikeDiff =
    /(^diff --git a\/)|(^--- a\/)|(^\+\+\+ b\/)|(^\*\*\* Begin Patch)|(\bfiles? changed\b)/m.test(text);
  if (!looksLikeDiff) return null;

  const files = Array.from(
    new Set([
      ...Array.from(text.matchAll(/^diff --git a\/(.+?) b\/.+$/gm), (m) => m[1]),
      ...Array.from(text.matchAll(/^\+\+\+ b\/(.+)$/gm), (m) => m[1]),
      ...Array.from(text.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm), (m) => m[1]),
    ]),
  );

  const statMatch = text.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  const insertions = statMatch?.[2] ? Number(statMatch[2]) : null;
  const deletions = statMatch?.[3] ? Number(statMatch[3]) : null;
  const fileCount = statMatch?.[1] ? Number(statMatch[1]) : files.length;

  return {
    kind: text.includes("*** Begin Patch") ? "patch" : "diff",
    files,
    fileCount: fileCount || files.length,
    insertions,
    deletions,
    rawText: text,
  };
}

function normalizeDiffText(text: string): string {
  return text.replace(/^\[task_diff\]\s*/m, "").trim();
}

function formatDiffHeadline(summary: DiffSummary): string {
  const parts = [
    summary.kind === "patch" ? "patch" : "diff",
    summary.fileCount > 0 ? `${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (summary.insertions != null || summary.deletions != null) {
    parts.push(`+${summary.insertions ?? 0}/-${summary.deletions ?? 0}`);
  }
  return parts.join(" · ");
}

function formatDiffFiles(summary: DiffSummary, max = 4): string {
  if (summary.files.length === 0) return "";
  const shown = summary.files.slice(0, max);
  const extra = summary.files.length - shown.length;
  return `files: ${shown.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`;
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "discover":
      return "discover";
    case "implement":
      return "implement";
    case "verify":
      return "verify";
    case "repair":
      return "repair";
    case "wrapup":
      return "wrap-up";
    case "review":
      return "review";
    case "summarize":
      return "summary";
    default:
      return phase || "task";
  }
}

function taskDisplayLabel(task: ChildTask): string {
  if (task.episode_is_root && task.episode_label) return task.episode_label;
  return phaseLabel(task.episode_phase || task.role);
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
