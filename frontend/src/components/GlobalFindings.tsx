import { useEffect, useState } from "react";

type Artifact = { id: number; type: string; content_json: string; task_id: number | null };

export function GlobalFindings({ jobId, tick }: { jobId: number | null; tick: number }) {
  const [rows, setRows] = useState<Artifact[]>([]);

  useEffect(() => {
    if (!jobId) {
      setRows([]);
      return;
    }
    void window.grist.getArtifacts(jobId).then((a) => setRows(a as Artifact[]));
  }, [jobId, tick]);

  const reducer = rows.filter((r) => r.type === "reducer_summary").slice(-1)[0];
  const hypotheses = rows.filter((r) => r.type === "hypothesis_list");

  let reducerParsed: Record<string, unknown> | null = null;
  if (reducer) {
    try {
      reducerParsed = JSON.parse(reducer.content_json) as Record<string, unknown>;
    } catch {
      reducerParsed = null;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto text-xs">
      <h3 className="font-semibold text-white">Global findings</h3>
      {reducerParsed ? (
        <div className="space-y-2 rounded border border-border p-2">
          <div className="text-muted">Reducer summary</div>
          <div className="text-sm text-white">{String(reducerParsed.summary_text || "")}</div>
          <div className="text-muted">Facts</div>
          <ul className="list-inside list-disc">
            {(reducerParsed.confirmed_facts as string[] | undefined)?.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="text-muted">Hypotheses</div>
          <ul className="list-inside list-disc">
            {(reducerParsed.top_hypotheses as string[] | undefined)?.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="text-muted">Contradictions</div>
          <ul className="list-inside list-disc text-amber-300">
            {(reducerParsed.contradictions as string[] | undefined)?.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="text-muted">Next</div>
          <ul className="list-inside list-disc">
            {(reducerParsed.recommended_next_tasks as string[] | undefined)?.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted">No reducer artifact yet.</p>
      )}
      {hypotheses.length > 0 && (
        <div>
          <div className="text-muted">Hypothesis artifacts</div>
          {hypotheses.map((h) => (
            <pre key={h.id} className="mt-1 max-h-24 overflow-auto rounded bg-black/30 p-1">
              {h.content_json.slice(0, 2000)}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
