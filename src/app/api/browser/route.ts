import { browserAvailable, browserClose, browserShot, browserStatus } from "@/lib/browser";
import { errorResponse, getWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const [status, availability] = await Promise.all([browserStatus(workspace.id), browserAvailable()]);
    const screenshot = status.open ? await browserShot(workspace.id) : null;
    return Response.json({ availability, status, screenshot }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    if (body.action !== "close") return Response.json({ error: "This panel can only close a session. Ask Aura to browse." }, { status: 400 });
    return Response.json(await browserClose(workspace.id), { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) { return errorResponse(error); }
}
