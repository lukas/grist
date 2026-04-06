import { useEffect, useState } from "react";

type Artifact = {
  id: number;
  type: string;
  task_id: number | null;
  content_json: string;
  confidence: number;
};

export function PatchComparison({ jobId, tick }: { jobId: number | null; tick: number }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    if (!jobId) {
      setArtifacts([]);
      return;
    }
    void window.grist.getArtifacts(jobId).then((a) => setArtifacts(a as Artifact[]));
  }, [jobId, tick]);

  const patches = artifacts.filter((a) => a.type === "candidate_patch");
  const verifs = artifacts.filter((a) => a.type === "verification_result");

  if (!jobId) return null;

  return (
    <div className="max-h-40 overflow-auto text-xs">
      <h3 className="mb-1 font-semibold text-white">Patches &amp; verification</h3>
      {patches.length === 0 && verifs.length === 0 && <p className="text-muted">No patch artifacts yet.</p>}
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-1 pr-2">Task</th>
            <th className="py-1 pr-2">Type</th>
            <th className="py-1">Preview</th>
          </tr>
        </thead>
        <tbody>
          {patches.map((p) => (
            <tr key={p.id} className="border-b border-border/40">
              <td className="py-1 pr-2">{p.task_id}</td>
              <td className="py-1 pr-2">patch</td>
              <td className="max-w-md truncate font-mono">{p.content_json.slice(0, 120)}…</td>
            </tr>
          ))}
          {verifs.map((v) => (
            <tr key={v.id} className="border-b border-border/40">
              <td className="py-1 pr-2">{v.task_id}</td>
              <td className="py-1 pr-2">verify</td>
              <td className="max-w-md truncate">{v.content_json.slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobId && (
        <button
          type="button"
          className="mt-2 rounded bg-indigo-700 px-2 py-1 text-white"
          onClick={() => {
            const g = window.prompt("Patch task goal", "Apply minimal fix for …");
            if (g) void window.grist.spawnPatchTask(jobId, g);
          }}
        >
          Spawn patch task (worktree)
        </button>
      )}
    </div>
  );
}
