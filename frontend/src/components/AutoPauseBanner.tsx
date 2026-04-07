interface PauseWarning {
  taskId: number;
  message: string;
}

interface Props {
  warnings: PauseWarning[];
  onDismiss: (idx: number) => void;
  onDismissAll: () => void;
}

const REASON_LABELS: Record<string, string> = {
  repeated_tool_call: "Repeated identical tool call 3\u00d7",
  consecutive_errors: "Multiple consecutive tool errors",
  no_tool_name: "Model not producing valid tool calls",
};

export function AutoPauseBanner({ warnings, onDismiss, onDismissAll }: Props) {
  if (!warnings.length) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-1 p-2 pointer-events-none">
      {warnings.map((w, i) => (
        <div
          key={`${w.taskId}-${i}`}
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-900/90 px-4 py-2 text-sm text-amber-100 shadow-lg backdrop-blur"
        >
          <span className="text-amber-400 text-base">&#9888;</span>
          <span>
            <strong>Task T{w.taskId} auto-paused:</strong>{" "}
            {REASON_LABELS[w.message] ?? w.message}
          </span>
          <button
            onClick={() => onDismiss(i)}
            className="ml-2 rounded px-2 py-0.5 text-xs hover:bg-amber-800/60"
          >
            Dismiss
          </button>
        </div>
      ))}
      {warnings.length > 1 && (
        <button
          onClick={onDismissAll}
          className="pointer-events-auto rounded px-3 py-1 text-xs text-amber-300 hover:bg-amber-800/50"
        >
          Dismiss all
        </button>
      )}
    </div>
  );
}
