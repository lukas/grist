import { useEffect, useState } from "react";

type Scope = "global" | "project";

export function SkillsModal({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [catalog, setCatalog] = useState<SkillCatalogView | null>(null);
  const [customSource, setCustomSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = () => {
    setError("");
    void window.grist.getSkillsCatalog(repo || undefined).then(setCatalog).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  useEffect(() => {
    refresh();
  }, [repo]);

  const install = async (skillOrUrl: string, scope: Scope) => {
    setBusy(`install:${skillOrUrl}:${scope}`);
    setError("");
    try {
      await window.grist.installSkill({ skillOrUrl, scope, repoPath: repo || undefined });
      setCustomSource("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (skillId: string, scope: Scope) => {
    setBusy(`remove:${skillId}:${scope}`);
    setError("");
    try {
      await window.grist.removeSkill({ skillId, scope, repoPath: repo || undefined });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg border border-border/80 bg-[#1a2233] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Skills</h2>
            <p className="text-xs text-muted">
              Install bundled or custom skill packs globally or per repo. Installed skills become visible to agents via
              `list_skills` and `read_skill`.
            </p>
          </div>
          <button type="button" className="rounded border border-border px-3 py-1 text-sm text-white" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mb-4 rounded border border-border bg-black/20 p-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Add custom skill</h3>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-border bg-black/30 p-2 text-xs text-white"
              placeholder="bundled skill id, local path, or URL to SKILL.md"
              value={customSource}
              onChange={(e) => setCustomSource(e.target.value)}
            />
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-xs text-white disabled:opacity-40"
              disabled={!customSource.trim() || !!busy}
              onClick={() => void install(customSource.trim(), repo ? "project" : "global")}
            >
              Install {repo ? "project" : "global"}
            </button>
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-xs text-white disabled:opacity-40"
              disabled={!customSource.trim() || !!busy}
              onClick={() => void install(customSource.trim(), "global")}
            >
              Install global
            </button>
          </div>
          {!repo && <p className="mt-2 text-[11px] text-muted">Pick a repo first to install project-local skills.</p>}
        </div>

        {error && <div className="mb-4 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">{error}</div>}

        {!catalog && !error && <p className="text-sm text-muted">Loading skills…</p>}

        {catalog && (<>
        <div className="mb-5 grid gap-4 md:grid-cols-2">
          <div className="rounded border border-border bg-black/20 p-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Installed global</h3>
            <div className="space-y-2">
              {catalog.installedGlobal.length === 0 && <p className="text-xs text-muted">(none)</p>}
              {catalog.installedGlobal.map((skill) => (
                <div key={`global-${skill.id}`} className="rounded border border-border/70 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm text-white">{skill.id}</div>
                      <p className="text-xs text-muted">{skill.description}</p>
                    </div>
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 text-[11px] text-white disabled:opacity-40"
                      disabled={!!busy}
                      onClick={() => void remove(skill.id, "global")}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-border bg-black/20 p-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Installed project</h3>
            <div className="space-y-2">
              {catalog.installedProject.length === 0 && <p className="text-xs text-muted">(none)</p>}
              {catalog.installedProject.map((skill) => (
                <div key={`project-${skill.id}`} className="rounded border border-border/70 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm text-white">{skill.id}</div>
                      <p className="text-xs text-muted">{skill.description}</p>
                    </div>
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 text-[11px] text-white disabled:opacity-40"
                      disabled={!!busy}
                      onClick={() => void remove(skill.id, "project")}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded border border-border bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Available</h3>
            <button type="button" className="text-xs text-accent" onClick={refresh}>Refresh</button>
          </div>
          <div className="space-y-2">
            {catalog.available.length === 0 && <p className="text-xs text-muted">(none)</p>}
            {catalog.available.map((skill) => (
              <div key={skill.id} className="rounded border border-border/70 p-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white">{skill.id}</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {skill.source}
                      </span>
                    </div>
                    <p className="text-xs text-muted">{skill.description}</p>
                  </div>
                  <div className="flex gap-2">
                    {repo && (
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-[11px] text-white disabled:opacity-40"
                        disabled={!!busy || skill.installedScopes.includes("project")}
                        onClick={() => void install(skill.sourceValue, "project")}
                      >
                        {skill.installedScopes.includes("project") ? "Project installed" : "Install project"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 text-[11px] text-white disabled:opacity-40"
                      disabled={!!busy || skill.installedScopes.includes("global")}
                      onClick={() => void install(skill.sourceValue, "global")}
                    >
                      {skill.installedScopes.includes("global") ? "Global installed" : "Install global"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </>)}
      </div>
    </div>
  );
}
