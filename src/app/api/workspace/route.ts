import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { cleanSettings, errorResponse, getWorkspace, getWorkspaceState } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const state = await getWorkspaceState(workspace);
    return Response.json(state, {
      headers: { "x-aura-workspace": workspace.id },
    });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    const [updated] = await db.update(workspaces).set({
      settings: { ...workspace.settings, ...cleanSettings(body.settings) },
    }).where(eq(workspaces.id, workspace.id)).returning();
    const state = await getWorkspaceState(updated);
    return Response.json(state, {
      headers: { "x-aura-workspace": updated.id },
    });
  } catch (error) { return errorResponse(error); }
}
