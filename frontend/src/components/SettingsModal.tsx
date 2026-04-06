import { useEffect, useState } from "react";

const PROVIDERS = [
  { id: "claude", label: "Claude", desc: "Anthropic API" },
  { id: "codex", label: "Codex / OpenAI", desc: "OpenAI-compatible" },
  { id: "kimi", label: "Kimi", desc: "OpenAI-compatible endpoint" },
  { id: "mock", label: "Mock", desc: "Offline / testing" },
] as const;

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.grist.getSettings().then((raw) => {
      const o = raw as Record<string, unknown>;
      setS({
        anthropicApiKey: String(o.anthropicApiKey ?? ""),
        openaiApiKey: String(o.openaiApiKey ?? ""),
        kimiBaseUrl: String(o.kimiBaseUrl ?? ""),
        kimiModel: String(o.kimiModel ?? ""),
        kimiApiKey: String(o.kimiApiKey ?? ""),
        claudeModel: String(o.claudeModel ?? "claude-sonnet-4-20250514"),
        codexModel: String(o.codexModel ?? "gpt-4.1"),
        defaultProvider: String(o.defaultProvider ?? "mock"),
        plannerProvider: String(o.plannerProvider ?? ""),
        reducerProvider: String(o.reducerProvider ?? ""),
        verifierProvider: String(o.verifierProvider ?? ""),
      });
      setLoaded(true);
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

  const pick = (provider: string) => setS((p) => ({ ...p, defaultProvider: provider }));
  const f = (key: string) => ({
    value: s[key] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setS((p) => ({ ...p, [key]: e.target.value })),
  });

  const hasKey = (provider: string) => {
    if (provider === "claude") return !!s.anthropicApiKey;
    if (provider === "codex") return !!s.openaiApiKey;
    if (provider === "kimi") return !!s.kimiApiKey || !!s.kimiBaseUrl;
    return true;
  };

  if (!loaded) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-white">Choose a provider</h2>
        <p className="mb-4 text-xs text-muted">Pick which LLM backend to use. Keys stay local (SQLite + .env).</p>

        {/* Provider cards */}
        <div className="mb-4 grid grid-cols-2 gap-2">
          {PROVIDERS.map((p) => {
            const active = s.defaultProvider === p.id;
            const ready = hasKey(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => pick(p.id)}
                className={`rounded-lg border-2 px-3 py-2 text-left transition ${
                  active
                    ? "border-accent bg-accent/10"
                    : "border-border hover:border-white/20"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{p.label}</span>
                  {active && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white">active</span>}
                </div>
                <p className="mt-0.5 text-xs text-muted">{p.desc}</p>
                {!ready && p.id !== "mock" && (
                  <p className="mt-1 text-[10px] text-amber-400">No key configured</p>
                )}
              </button>
            );
          })}
        </div>

        {/* Config for selected provider */}
        <div className="mb-4 rounded border border-border bg-black/20 p-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            {PROVIDERS.find((p) => p.id === s.defaultProvider)?.label ?? s.defaultProvider} config
          </h3>

          {s.defaultProvider === "claude" && (
            <div className="grid gap-2">
              <label className="text-xs text-muted">
                Anthropic API key
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono text-xs" type="password" {...f("anthropicApiKey")} />
              </label>
              <label className="text-xs text-muted">
                Model
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 text-xs" {...f("claudeModel")} placeholder="claude-sonnet-4-20250514" />
              </label>
            </div>
          )}

          {s.defaultProvider === "codex" && (
            <div className="grid gap-2">
              <label className="text-xs text-muted">
                OpenAI API key
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono text-xs" type="password" {...f("openaiApiKey")} />
              </label>
              <label className="text-xs text-muted">
                Model
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 text-xs" {...f("codexModel")} placeholder="gpt-4.1" />
              </label>
            </div>
          )}

          {s.defaultProvider === "kimi" && (
            <div className="grid gap-2">
              <label className="text-xs text-muted">
                Base URL (include /v1)
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono text-xs" {...f("kimiBaseUrl")} placeholder="http://127.0.0.1:8000/v1" />
              </label>
              <label className="text-xs text-muted">
                API key
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 font-mono text-xs" type="password" {...f("kimiApiKey")} />
              </label>
              <label className="text-xs text-muted">
                Model
                <input className="mt-1 w-full rounded border border-border bg-black/30 p-1 text-xs" {...f("kimiModel")} placeholder="moonshotai/Kimi-K2.5" />
              </label>
            </div>
          )}

          {s.defaultProvider === "mock" && (
            <p className="text-xs text-muted">No configuration needed. Returns placeholder responses for testing.</p>
          )}
        </div>

        {/* Per-role overrides (collapsed) */}
        <details className="mb-4">
          <summary className="cursor-pointer text-xs text-muted hover:text-white">Per-role overrides (advanced)</summary>
          <div className="mt-2 grid gap-2 pl-2">
            {(["plannerProvider", "reducerProvider", "verifierProvider"] as const).map((key) => (
              <label key={key} className="text-xs text-muted">
                {key.replace("Provider", "")}
                <select className="mt-1 w-full rounded border border-border bg-black/30 p-1 text-xs" {...f(key)}>
                  <option value="">same as default</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                  <option value="kimi">kimi</option>
                  <option value="mock">mock</option>
                </select>
              </label>
            ))}
          </div>
        </details>

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rounded bg-accent px-3 py-1.5 text-sm text-white" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
