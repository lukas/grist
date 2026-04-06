import { useEffect, useState } from "react";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Record<string, string>>({});

  useEffect(() => {
    void window.grist.getSettings().then((raw) => {
      const o = raw as Record<string, unknown>;
      setS({
        anthropicApiKey: String(o.anthropicApiKey ?? ""),
        openaiApiKey: String(o.openaiApiKey ?? ""),
        kimiBaseUrl: String(o.kimiBaseUrl ?? "http://127.0.0.1:11434/v1"),
        kimiModel: String(o.kimiModel ?? "kimi"),
        kimiApiKey: String(o.kimiApiKey ?? ""),
        claudeModel: String(o.claudeModel ?? "claude-sonnet-4-20250514"),
        codexModel: String(o.codexModel ?? "gpt-4.1"),
        defaultProvider: String(o.defaultProvider ?? "mock"),
        plannerProvider: String(o.plannerProvider ?? ""),
        reducerProvider: String(o.reducerProvider ?? ""),
        verifierProvider: String(o.verifierProvider ?? ""),
      });
    });
  }, []);

  const save = () => {
    void window.grist.setSettings({
      ...s,
      plannerProvider: s.plannerProvider || undefined,
      reducerProvider: s.reducerProvider || undefined,
      verifierProvider: s.verifierProvider || undefined,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-panel p-4 text-sm shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-white">Provider settings</h2>
        <p className="mb-3 text-xs text-muted">Keys stay local (SQLite). Use mock for offline tests.</p>
        <div className="grid gap-2">
          <label className="text-xs text-muted">
            Default provider
            <select
              className="mt-1 w-full rounded border border-border bg-black/30 p-1"
              value={s.defaultProvider}
              onChange={(e) => setS((p) => ({ ...p, defaultProvider: e.target.value }))}
            >
              <option value="mock">mock</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="kimi">kimi</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            Anthropic API key
            <input
              className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono"
              value={s.anthropicApiKey}
              onChange={(e) => setS((p) => ({ ...p, anthropicApiKey: e.target.value }))}
            />
          </label>
          <label className="text-xs text-muted">
            OpenAI API key (Codex)
            <input
              className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono"
              value={s.openaiApiKey}
              onChange={(e) => setS((p) => ({ ...p, openaiApiKey: e.target.value }))}
            />
          </label>
          <label className="text-xs text-muted">
            Kimi base URL
            <input
              className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono"
              value={s.kimiBaseUrl}
              onChange={(e) => setS((p) => ({ ...p, kimiBaseUrl: e.target.value }))}
            />
          </label>
          <label className="text-xs text-muted">
            Kimi model
            <input
              className="mt-1 w-full rounded border border-border bg-black/30 p-1"
              value={s.kimiModel}
              onChange={(e) => setS((p) => ({ ...p, kimiModel: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rounded bg-accent px-3 py-1 text-white" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
