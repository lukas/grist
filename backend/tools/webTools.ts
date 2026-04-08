import type { ToolContext, ToolResult } from "./toolTypes.js";

const EXA_BASE = "https://api.exa.ai";

function getExaKey(): string | null {
  return process.env.EXA_API_KEY || null;
}

async function exaPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const key = getExaKey();
  if (!key) throw new Error("EXA_API_KEY not set — web tools unavailable");
  const res = await fetch(`${EXA_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Exa ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

type SearchResult = {
  title?: string;
  url?: string;
  highlights?: string[];
  summary?: string;
};

export async function toolSearchWeb(
  _ctx: ToolContext,
  args: { query: string; numResults?: number },
): Promise<ToolResult> {
  try {
    const data = (await exaPost("/search", {
      query: args.query,
      numResults: Math.min(args.numResults ?? 5, 10),
      type: "auto",
      contents: { highlights: { maxCharacters: 3000 } },
    })) as { results?: SearchResult[] };

    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      highlights: r.highlights ?? [],
    }));

    return { ok: true, data: { results } };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

export async function toolBrowseWeb(
  _ctx: ToolContext,
  args: { url: string; query?: string },
): Promise<ToolResult> {
  try {
    const data = (await exaPost("/contents", {
      urls: [args.url],
      text: true,
      ...(args.query ? { summary: { query: args.query } } : {}),
    })) as { results?: { title?: string; url?: string; text?: string; summary?: string }[] };

    const page = data.results?.[0];
    if (!page) return { ok: false, error: "No content returned for URL" };

    const text = (page.text ?? "").slice(0, 15000);
    return {
      ok: true,
      data: {
        title: page.title ?? "",
        url: page.url ?? args.url,
        summary: page.summary ?? "",
        text,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

export function exaAvailable(): boolean {
  return !!getExaKey();
}
