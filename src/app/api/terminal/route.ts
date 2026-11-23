import { errorResponse, getWorkspace } from "@/lib/workspace";
import { runTerminal } from "@/lib/terminal";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Direct terminal access for the Terminal panel. Commands run only inside this workspace's private files. */
export async function GET(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const [row] = await db.select({ cwd: workspaces.terminalCwd }).from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    return Response.json({ cwd: row?.cwd ?? "/" }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    const command = typeof body.command === "string" ? body.command : "";
    // The user typed this command in the terminal themselves, so deletion is explicitly requested.
    const result = await runTerminal({ workspaceId: workspace.id, command, explicitDelete: true });
    return Response.json(result, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) { return errorResponse(error); }
}
