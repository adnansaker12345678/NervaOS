import "server-only";
import QRCode from "qrcode";
import { db } from "@/db";
import { workspaceFiles } from "@/db/schema";

/** QR codes and AI images, saved into the workspace's own files. */

const slug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

async function saveFile(workspaceId: string, path: string, content: string) {
  await db.insert(workspaceFiles).values({ workspaceId, path, isDir: false, content })
    .onConflictDoUpdate({ target: [workspaceFiles.workspaceId, workspaceFiles.path], set: { content, updatedAt: new Date() } });
}

export async function makeQrCode(text: string, workspaceId: string): Promise<{ file: string; dataUrl: string }> {
  const input = text.trim().slice(0, 1000);
  if (!input) throw new Error("Say what the QR code should contain.");
  const dataUrl = await QRCode.toDataURL(input, { width: 512, margin: 2, errorCorrectionLevel: "M" });
  const file = `/images/qr-${Date.now().toString(36)}.png`;
  await saveFile(workspaceId, file, dataUrl);
  return { file, dataUrl };
}

export async function generateImage(prompt: string, workspaceId: string): Promise<{ file: string; url: string; dataUrl: string }> {
  const clean = prompt.trim().slice(0, 500);
  if (!clean) throw new Error("Describe the image to create.");
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}?width=768&height=512&nologo=true&seed=${seed}&model=flux`;
  let response = await fetch(url, { signal: AbortSignal.timeout(100_000), headers: { "User-Agent": "AuraAgent/1.1" }, cache: "no-store" });
  if (!response.ok && [402, 429, 503].includes(response.status)) {
    // The free tier throttles bursts; one patient retry usually succeeds.
    const waitMs = Math.min(45_000, Math.max(8_000, Number(response.headers.get("retry-after") || 0) * 1000 || 15_000));
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(url, { signal: AbortSignal.timeout(100_000), headers: { "User-Agent": "AuraAgent/1.1" }, cache: "no-store" });
  }
  if (!response.ok) throw new Error(`The image service answered HTTP ${response.status}. Try again in a moment.`);
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("The image service didn't return a picture. Try a simpler prompt.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 2_000_000) throw new Error("The generated image was too large to keep.");
  const dataUrl = `data:${type.split(";")[0]};base64,${buffer.toString("base64")}`;
  const file = `/images/${slug(clean)}-${seed}.md`;
  await saveFile(workspaceId, file, `# ${clean}\n\nCreated: ${new Date().toISOString()}\nSource: ${url}\n`);
  return { file, url, dataUrl };
}
