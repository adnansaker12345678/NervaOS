import { dismissJob, listJobs, startBackgroundJob } from "@/lib/jobs";
import { errorResponse, getWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const BACKGROUND_TOOLS = new Set(["image_generate", "web_search", "web_fetch", "browser_open", "hire_agent", "terminal", "weather", "news", "qr_code"]);

export async function GET(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    return Response.json({ jobs: listJobs(workspace.id) }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Start a background tool on the server. The job keeps running after the client
 * disconnects — this is the always-on path the agent uses for run_in_background.
 */
export async function POST(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    const tool = String(body.tool ?? "").trim();
    if (!BACKGROUND_TOOLS.has(tool)) return Response.json({ error: `Tool “${tool}” cannot run in the background.` }, { status: 400 });
    const input = String(body.input ?? "").trim().slice(0, 2000);
    if (!input) return Response.json({ error: "Give the tool its input." }, { status: 400 });
    const args: Record<string, unknown> = tool === "web_search" || tool === "news" ? { query: input }
      : tool === "web_fetch" || tool === "browser_open" ? { url: input }
        : tool === "image_generate" ? { prompt: input }
          : tool === "terminal" ? { command: input }
            : tool === "weather" ? { place: input }
              : tool === "qr_code" ? { text: input }
                : tool === "hire_agent" ? { specialist: String(body.specialist ?? "researcher"), task: input }
                  : { input };
    const { runTool } = await import("@/lib/agent");
    const job = startBackgroundJob({
      workspaceId: workspace.id,
      conversationId: String(body.conversationId ?? "background"),
      tool,
      label: String(body.label ?? input).slice(0, 120) || tool,
      detail: "Running on the Aura server…",
      panel: tool === "terminal" ? "terminal" : tool === "browser_open" ? "browser" : undefined,
      run: async (signal, update) => {
        const ctx = {
          workspace,
          conversationId: String(body.conversationId ?? "background"),
          userText: input,
          emit: () => undefined,
          signal,
          clientGone: () => false,
          timezone: String(body.timezone ?? "UTC"),
          planning: "off" as const,
        };
        const result = await runTool(tool, args, ctx, crypto.randomUUID(), 0);
        if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
          throw new Error(String((result as Record<string, unknown>).error).slice(0, 200));
        }
        const summary = typeof (result as { summary?: unknown })?.summary === "string"
          ? (result as { summary: string }).summary.slice(0, 1500)
          : typeof (result as { output?: unknown })?.output === "string" ? String((result as { output: unknown }).output).slice(0, 1500)
            : typeof (result as { result?: unknown })?.result === "string" ? String((result as { result: unknown }).result).slice(0, 1500)
              : JSON.stringify(result).slice(0, 1500);
        return { detail: "Completed on the server", output: summary };
      },
    });
    return Response.json({ job: job }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const id = new URL(request.url).searchParams.get("id") ?? undefined;
    return Response.json({ jobs: dismissJob(workspace.id, id) }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) {
    return errorResponse(error);
  }
}
