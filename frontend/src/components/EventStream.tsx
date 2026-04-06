import { useEffect, useState } from "react";

type Ev = { id: number; level: string; type: string; message: string; created_at: string; task_id: number | null };

export function EventStream({ jobId, tick }: { jobId: number | null; tick: number }) {
  const [events, setEvents] = useState<Ev[]>([]);

  useEffect(() => {
    if (!jobId) {
      setEvents([]);
      return;
    }
    void window.grist.getEvents(jobId).then((e) => setEvents((e as Ev[]).slice().reverse()));
  }, [jobId, tick]);

  if (!jobId) return <p className="text-muted text-xs">Events appear when a job runs.</p>;

  return (
    <div className="flex h-full flex-col gap-1">
      <h3 className="shrink-0 text-xs font-semibold text-white">Event stream</h3>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-tight">
        {events.map((ev) => (
          <div key={ev.id} className="border-b border-border/50 py-0.5">
            <span className="text-muted">{ev.created_at.slice(11, 19)}</span>{" "}
            <span className={ev.level === "error" ? "text-red-400" : ev.level === "warn" ? "text-amber-300" : "text-gray-300"}>
              [{ev.type}]
            </span>{" "}
            {ev.task_id != null && <span className="text-accent">T{ev.task_id}</span>}{" "}
            {ev.message}
          </div>
        ))}
      </div>
    </div>
  );
}
