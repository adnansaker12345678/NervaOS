import "server-only";
import type { BackgroundJob } from "@/lib/types";

type StoredJob = BackgroundJob & { workspaceId: string; abort?: AbortController };
type JobRegistry = typeof globalThis & { __auraJobs?: Map<string, StoredJob[]> };
const registry = globalThis as JobRegistry;
const store = registry.__auraJobs ?? (registry.__auraJobs = new Map<string, StoredJob[]>());

const MAX_JOBS_PER_WORKSPACE = 16;
const JOB_TTL_MS = 30 * 60_000;

function prune(workspaceId: string): StoredJob[] {
  const now = Date.now();
  const list = (store.get(workspaceId) ?? []).filter(
    (job) => job.status === "running" || now - (job.finishedAt ?? job.startedAt) < JOB_TTL_MS
  );
  if (list.length > MAX_JOBS_PER_WORKSPACE) list.splice(0, list.length - MAX_JOBS_PER_WORKSPACE);
  store.set(workspaceId, list);
  return list;
}

function toPublic(job: StoredJob): BackgroundJob {
  const { workspaceId: _ws, abort: _ab, ...pub } = job;
  return pub;
}

export function listJobs(workspaceId: string): BackgroundJob[] {
  return prune(workspaceId).slice().reverse().map(toPublic);
}

export function startBackgroundJob(options: {
  workspaceId: string;
  conversationId: string;
  tool: string;
  label: string;
  detail: string;
  panel?: string;
  run: (signal: AbortSignal, update: (patch: Partial<Pick<BackgroundJob, "detail" | "output" | "image" | "panel">>) => void) => Promise<{ detail?: string; output?: string; image?: string; panel?: string }>;
}): BackgroundJob {
  const list = prune(options.workspaceId);
  const abort = new AbortController();
  const job: StoredJob = {
    id: crypto.randomUUID(),
    workspaceId: options.workspaceId,
    conversationId: options.conversationId,
    tool: options.tool,
    label: options.label,
    detail: options.detail,
    status: "running",
    startedAt: Date.now(),
    panel: options.panel,
    abort,
  };
  list.push(job);
  store.set(options.workspaceId, list);

  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
  const update = (patch: Partial<Pick<BackgroundJob, "detail" | "output" | "image" | "panel">>) => {
    if (patch.detail !== undefined) job.detail = patch.detail;
    if (patch.output !== undefined) job.output = patch.output;
    if (patch.image !== undefined) job.image = patch.image;
    if (patch.panel !== undefined) job.panel = patch.panel;
  };

  void options
    .run(signal, update)
    .then((result) => {
      if (job.status !== "running") return;
      job.status = "done";
      job.finishedAt = Date.now();
      if (result.detail) job.detail = result.detail;
      if (result.output) job.output = result.output;
      if (result.image) job.image = result.image;
      if (result.panel) job.panel = result.panel;
      job.abort = undefined;
    })
    .catch((error: unknown) => {
      if (job.status !== "running") return;
      job.status = "error";
      job.finishedAt = Date.now();
      job.detail = error instanceof Error ? error.message.slice(0, 200) : "Background task failed.";
      job.abort = undefined;
    });

  return toPublic(job);
}

export function dismissJob(workspaceId: string, id?: string): BackgroundJob[] {
  const list = prune(workspaceId);
  if (!id) {
    // Clear finished jobs, keep running ones alive
    const kept = list.filter((job) => job.status === "running");
    store.set(workspaceId, kept);
    return kept.slice().reverse().map(toPublic);
  }
  const target = list.find((job) => job.id === id);
  if (target) {
    if (target.status === "running") target.abort?.abort();
    const next = list.filter((job) => job.id !== id);
    store.set(workspaceId, next);
    return next.slice().reverse().map(toPublic);
  }
  return list.slice().reverse().map(toPublic);
}
