"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowDownToLine, ArrowRight, ListChecks, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronsUpDown, CircleAlert, CircleHelp, Clock3, Copy, Feather, FileText, Grid2X2, Leaf, ListTodo, LoaderCircle, LockKeyhole, MessageCircle, Mic, PanelLeftClose, PanelLeftOpen, Pencil, Library, Puzzle, Compass, Pin, Plus, Search, Settings2, ShieldCheck, Shuffle, SlidersHorizontal, Sparkles, Square, Terminal, WandSparkles, X } from "lucide-react";
import { AssistantReply } from "@/components/reply";
import { AuraMark, OrbitArt } from "@/components/brand";
import { ChatMenu, IconButton, Modal } from "@/components/ui";
import WorkspacePanels, { type ConfirmRequest } from "@/components/workspace-panels";
import { appendTextBlock, extractContent, upsertActionBlock, upsertActionList } from "@/lib/blocks";
import { api, relativeDate, setClientWorkspaceId, userTimeZone, workspaceHeaders } from "@/lib/client";
import { defaultSettings, type AgentAction, type Attachment, type BackgroundJob, type ChatEvent, type Conversation, type Message, type Panel, type Settings, type WorkspaceState } from "@/lib/types";

const initialState: WorkspaceState = { workspaceId: "", settings: defaultSettings, engine: { id: "aura-free", label: "Aura free engine", model: "openai-fast", keyless: true, vision: false, note: "Verified keyless backend engines with automatic rotation.", alternates: 1, cooldownSeconds: 0 }, conversations: [], tasks: [], notes: [], memories: [], events: [], bookmarks: [] };
const suggestionSets = [
  [
    { icon: Feather, color: "peach", title: "Find the right words", description: "From a blank page to a little brilliance.", prompt: "Help me write something. Ask me what it’s for and the tone I have in mind." },
    { icon: ListTodo, color: "lavender", title: "Bring a little order", description: "A clear head starts with a clearer plan.", prompt: "Help me plan my day" },
    { icon: SlidersHorizontal, color: "sage", title: "Make yourself at home", description: "Your space, set up your way. Just ask.", prompt: "Turn on focus mode" },
  ],
  [
    { icon: FileText, color: "peach", title: "Keep a good thought", description: "Give your next big idea a place to grow.", prompt: "Save a note: " },
    { icon: CheckCheck, color: "lavender", title: "Take the first step", description: "Little actions make big things happen.", prompt: "Create tasks: " },
    { icon: WandSparkles, color: "sage", title: "Meet your new sidekick", description: "A little help can open up a lot of room.", prompt: "What can you do?" },
  ],
  [
    { icon: Leaf, color: "sage", title: "Find a little focus", description: "Turn down the noise. Follow a thought.", prompt: "Turn on focus mode" },
    { icon: Feather, color: "peach", title: "Untangle an idea", description: "A fresh perspective is a conversation away.", prompt: "I have an idea I’d like to think through. Can you ask me a few questions to help me clarify it?" },
    { icon: ListTodo, color: "lavender", title: "See the bigger picture", description: "A little check-in with what’s on your list.", prompt: "Show my tasks" },
  ],
];

type VoiceRecognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; start: () => void; stop: () => void;
};
type VoiceWindow = Window & { SpeechRecognition?: new () => VoiceRecognition; webkitSpeechRecognition?: new () => VoiceRecognition };

function playChime() {
  try {
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.connect(gain); gain.connect(ctx.destination);
    oscillator.type = "sine"; oscillator.frequency.setValueAtTime(660, ctx.currentTime); oscillator.frequency.setValueAtTime(880, ctx.currentTime + .11);
    gain.gain.setValueAtTime(.035, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .35);
    oscillator.start(); oscillator.stop(ctx.currentTime + .36); oscillator.onended = () => { void ctx.close(); };
  } catch { /* Audio is optional and browser permissions vary. */ }
}

export default function AuraApp() {
  const [state, setState] = useState<WorkspaceState>(initialState);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [status, setStatus] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [showTip, setShowTip] = useState(true);
  const [ideas, setIdeas] = useState(0);
  const [mode, setMode] = useState<"auto" | "workspace" | "plan">("auto");
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [rename, setRename] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [listening, setListening] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const voiceRef = useRef<VoiceRecognition | null>(null);
  const notify = useCallback((text: string) => setToast(text), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const closeConfirm = useCallback(() => { if (!confirmBusy) setConfirm(null); }, [confirmBusy]);
  const closeRename = useCallback(() => setRename(null), []);
  const closePreview = useCallback(() => setPreview(null), []);

  const refresh = useCallback(async () => {
    const data = await api<WorkspaceState>("/api/workspace");
    if (data.workspaceId) setClientWorkspaceId(data.workspaceId);
    setState(data);
    if (Array.isArray(data.jobs)) setJobs(data.jobs);
    setReady(true); setLoadError("");
    return data;
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const data = await api<WorkspaceState>("/api/workspace");
        if (!mounted) return;
        if (data.workspaceId) setClientWorkspaceId(data.workspaceId);
        setState(data);
        if (Array.isArray(data.jobs)) setJobs(data.jobs);
        setReady(true);
        try { setShowTip(sessionStorage.getItem("aura-tip-dismissed") !== "true"); } catch { /* ignore */ }
        const id = new URL(window.location.href).searchParams.get("chat");
        if (id) {
          setLoadingChat(true);
          try {
            const chat = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
            if (mounted) { setActiveId(id); setMessages(chat.messages); }
          } catch {
            // If specific chat wasn't found, keep workspace clean on home stage
            window.history.replaceState(null, "", window.location.pathname);
          }
        }
      } catch (error) { if (mounted) setLoadError((error as Error).message); }
      finally { if (mounted) setLoadingChat(false); }
    };
    void load();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = state.settings.theme === "system" ? (media.matches ? "dark" : "light") : state.settings.theme; };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.settings.theme]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = messagesScrollRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollTopRef.current = el.scrollHeight;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 3;
    lastScrollTopRef.current = el.scrollTop;
    if (scrolledUp && distanceFromBottom > 24) {
      stickToBottomRef.current = false;
      setShowJumpToBottom(true);
      return;
    }
    if (distanceFromBottom <= 36) {
      stickToBottomRef.current = true;
      setShowJumpToBottom(false);
    } else if (distanceFromBottom > 72) {
      stickToBottomRef.current = false;
      setShowJumpToBottom(true);
    }
  }, []);

  const handleMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      stickToBottomRef.current = false;
      const el = messagesScrollRef.current;
      if (el && el.scrollHeight - el.clientHeight > 40) setShowJumpToBottom(true);
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  const runningJobsCount = jobs.filter((job) => job.status === "running").length;
  useEffect(() => {
    if (!runningJobsCount && !jobsOpen) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await api<{ jobs: BackgroundJob[] }>("/api/jobs");
        if (!active) return;
        setJobs((prev) => {
          const prevRunning = new Set(prev.filter((j) => j.status === "running").map((j) => j.id));
          for (const item of res.jobs) {
            if (prevRunning.has(item.id) && item.status === "done") {
              notify(`Background task done: ${item.label}`);
              void refresh().catch(() => {});
            }
          }
          return res.jobs;
        });
      } catch { /* ignore transient poll errors */ }
    };
    const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [runningJobsCount, jobsOpen, notify, refresh]);

  const removeJob = async (id?: string) => {
    try {
      const res = await api<{ jobs: BackgroundJob[] }>(id ? `/api/jobs?id=${encodeURIComponent(id)}` : "/api/jobs", { method: "DELETE" });
      setJobs(res.jobs);
      if (!res.jobs.length) setJobsOpen(false);
    } catch (error) { notify((error as Error).message); }
  };

  useEffect(() => { if (panel) setMobileSidebar(false); }, [panel]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 4800); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [messages, status, scrollToBottom]);
  useEffect(() => () => { abortRef.current?.abort(); voiceRef.current?.stop(); if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); }, []);

  const saveSettings = useCallback(async (settings: Partial<Settings>) => {
    const updated = await api<WorkspaceState>("/api/workspace", { method: "PATCH", body: JSON.stringify({ settings }) });
    setState(updated);
  }, []);

  const newChat = useCallback(() => {
    if (busy) { notify("Finish or stop the current response before starting a new chat."); return; }
    setActiveId(null); setMessages([]); setInput(""); setAttachments([]); setPanel(null); setMobileSidebar(false);
    window.history.replaceState(null, "", window.location.pathname);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [busy, notify]);

  const openChat = useCallback(async (id: string) => {
    if (busy) { notify("Finish or stop the current response before switching conversations."); return; }
    setLoadingChat(true); setPanel(null); setMobileSidebar(false);
    try {
      const data = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
      stickToBottomRef.current = true; setShowJumpToBottom(false);
      setMessages(data.messages); setActiveId(id); setInput(""); setAttachments([]);
      window.history.replaceState(null, "", `?chat=${id}`);
    } catch (error) { notify((error as Error).message); }
    finally { setLoadingChat(false); }
  }, [busy, notify]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); newChat(); }
      if (event.key === "/") { event.preventDefault(); setPanel("history"); }
      if (event.key === ",") { event.preventDefault(); setPanel("settings"); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [newChat]);

  const changeChat = async (id: string, patch: Partial<Conversation>) => {
    try { await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); await refresh(); }
    catch (error) { notify((error as Error).message); }
  };
  const deleteChat = (chat: Conversation) => {
    if (busy && activeId === chat.id) { notify("Stop the current response before deleting this conversation."); return; }
    setConfirm({ title: "Let this conversation go?", detail: `“${chat.title}” and all its messages will be permanently deleted.`, action: async () => { await api(`/api/conversations/${chat.id}`, { method: "DELETE" }); if (activeId === chat.id) newChat(); await refresh(); notify("Conversation deleted."); } });
  };
  const renameChat = (chat: Conversation) => { setRename(chat); setRenameValue(chat.title); };
  const usePrompt = (text: string) => { setInput(text); setPanel(null); requestAnimationFrame(() => composerRef.current?.focus()); };

  const takeAction = (action: AgentAction) => {
    if (action.data?.download === "/api/export") {
      window.location.assign("/api/export");
      return;
    }
    const target = action.data?.panel;
    if (["tasks", "notes", "settings", "history", "help", "terminal", "browser", "library", "skills"].includes(String(target))) setPanel(target as Panel);
    else setPanel(action.type === "note" ? "notes" : action.type === "task" ? "tasks" : action.type === "conversation" ? "history" : ["memory", "event", "bookmark"].includes(action.type) ? "library" : "settings");
  };

  const copyText = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => notify("Copied.")).catch(() => notify("Couldn’t access the clipboard. Please select and copy the text."));
  }, [notify]);

  /** Ticks a task from inside a reply. The change is saved to the real task list. */
  const toggleTask = useCallback(async (id: string, completed: boolean) => {
    setState((prev) => ({ ...prev, tasks: prev.tasks.map((task) => task.id === id ? { ...task, completed } : task) }));
    try { await api("/api/items", { method: "PATCH", body: JSON.stringify({ kind: "task", id, completed }) }); }
    catch (error) { notify((error as Error).message); }
    finally { void refresh().catch(() => {}); }
  }, [notify, refresh]);

  const speak = (message: Message) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { notify("Read aloud isn’t supported in this browser."); return; }
    window.speechSynthesis.cancel();
    if (speakingId === message.id) { setSpeakingId(null); return; }
    const plain = message.content.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
    if (!plain) return;
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.lang = /[\u0980-\u09ff]/.test(plain) ? "bn-BD" : "en-US";
    utterance.onend = () => setSpeakingId((current) => current === message.id ? null : current);
    utterance.onerror = () => setSpeakingId((current) => current === message.id ? null : current);
    setSpeakingId(message.id);
    window.speechSynthesis.speak(utterance);
  };

  const saveReplyAsNote = async (text: string) => {
    const title = text.replace(/[#*_`>]/g, "").split("\n").find((line) => line.trim())?.trim().slice(0, 70) || "Saved reply";
    try {
      await api("/api/items", { method: "POST", body: JSON.stringify({ kind: "note", title, content: text.slice(0, 30000) }) });
      await refresh();
      notify("Saved to My notes.");
    } catch (error) { notify((error as Error).message); }
  };

  const sendFeedback = async (id: string, feedback: "up" | "down" | null) => {
    const previous = messages.find((message) => message.id === id)?.feedback ?? null;
    setMessages((prev) => prev.map((message) => message.id === id ? { ...message, feedback } : message));
    try { await api(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ feedback }) }); }
    catch (error) {
      setMessages((prev) => prev.map((message) => message.id === id ? { ...message, feedback: previous } : message));
      notify((error as Error).message);
    }
  };

  const send = async (override?: { text?: string; regenerate?: boolean }) => {
    const regenerate = override?.regenerate === true;
    const preset = override?.text?.trim();
    const text = regenerate ? "" : (preset ?? input.trim());
    const files = regenerate || preset ? [] : attachments;
    if (busy || (!regenerate && !text && !files.length)) return;
    if (!ready) { notify("Your workspace is still connecting. Please try again in a moment."); return; }
    if (regenerate && !activeId) return;
    const snapshot = messages;
    const userId = crypto.randomUUID(), assistantId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    stickToBottomRef.current = true; setShowJumpToBottom(false);
    if (!regenerate && !preset) { setInput(""); setAttachments([]); }
    setBusy(true); setStatus("Thinking it through…");
    const placeholder: Message = { id: assistantId, conversationId: activeId || "", role: "assistant", content: "", actions: [], blocks: [], attachments: [], createdAt: timestamp };
    setMessages((prev) => regenerate
      ? [...prev.slice(0, -1), placeholder]
      : [...prev, { id: userId, conversationId: activeId || "", role: "user", content: text, actions: [], blocks: [], attachments: files, createdAt: timestamp }, placeholder]);
    const controller = new AbortController(); abortRef.current = controller;
    let started = false, finished = false;
    // Text arrives many times a second. Drawing every piece separately makes the reply crawl,
    // so pieces are collected and drawn together about twenty times a second.
    let pendingText = "";
    let drawTimer: ReturnType<typeof setTimeout> | null = null;
    const drawText = () => {
      if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = "";
      setStatus("");
      setMessages((prev) => prev.map((message) => {
        if (message.id !== assistantId) return message;
        const nextBlocks = appendTextBlock(message.blocks ?? [], chunk);
        return { ...message, blocks: nextBlocks, content: extractContent(nextBlocks) };
      }));
    };
    const handle = (event: ChatEvent) => {
      if (event.type === "delta") {
        pendingText += event.text;
        if (!drawTimer) drawTimer = setTimeout(drawText, 45);
        return;
      }
      drawText();
      if (event.type === "start") {
        started = true;
        setActiveId(event.conversationId);
        if (event.workspaceId) setClientWorkspaceId(event.workspaceId);
        window.history.replaceState(null, "", `?chat=${event.conversationId}`);
        setMessages((prev) => prev.map((message) => message.id === userId ? { ...event.userMessage, clientId: userId } : message));
      }
      if (event.type === "status") setStatus(event.text);
      if (event.type === "action") {
        setMessages((prev) => prev.map((message) => {
          if (message.id !== assistantId) return message;
          return {
            ...message,
            blocks: upsertActionBlock(message.blocks ?? [], event.action),
            actions: upsertActionList(message.actions, event.action),
          };
        }));
        if (event.action.type === "settings" && event.action.data?.settings && event.action.status !== "running") {
          const patch = event.action.data.settings as Partial<Settings>;
          setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
        }
        if (event.action.type === "navigate" && event.action.status !== "running") takeAction(event.action);
        if (typeof event.action.data?.jobId === "string") {
          void api<{ jobs: BackgroundJob[] }>("/api/jobs").then((res) => setJobs(res.jobs)).catch(() => {});
        }
        if (event.action.status !== "running") void refresh().catch(() => {});
      }
      if (event.type === "done") { finished = true; setMessages((prev) => prev.map((message) => message.id === assistantId ? { ...event.message, clientId: assistantId } : message)); }
      if (event.type === "error") notify(event.error);
    };
    try {
      let response = await fetch("/api/chat", {
        method: "POST",
        headers: workspaceHeaders(),
        body: JSON.stringify({ content: text, conversationId: activeId, attachments: files, localOnly: mode === "workspace", planning: mode === "plan" ? "always" : undefined, regenerate, timezone: userTimeZone() }),
        signal: controller.signal,
      });
      const returnedWs = response.headers.get("x-aura-workspace");
      if (returnedWs) setClientWorkspaceId(returnedWs);

      if (!response.ok && response.status === 404 && activeId && !regenerate) {
        // Transparent fallback: if conversation was not found, retry smoothly without conversationId
        response = await fetch("/api/chat", {
          method: "POST",
          headers: workspaceHeaders(),
          body: JSON.stringify({ content: text, conversationId: null, attachments: files, localOnly: mode === "workspace", timezone: userTimeZone() }),
          signal: controller.signal,
        });
        const retryWs = response.headers.get("x-aura-workspace");
        if (retryWs) setClientWorkspaceId(retryWs);
      }

      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || "Couldn’t send your message."); }
      if (!response.body) throw new Error("Couldn’t open the response stream. Please try again.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); if (line.trim()) handle(JSON.parse(line) as ChatEvent); }
      }
      if (buffer.trim()) handle(JSON.parse(buffer) as ChatEvent);
      drawText();
      if (!finished) throw new Error("The connection was interrupted. Your saved conversation is available in history.");
      if (state.settings.sound) playChime();
    } catch (error) {
      drawText();
      const settle = (message: Message, fallbackText: string): Message => {
        const cleaned = (message.blocks ?? []).map((block) => block.type === "action" && block.action.status === "running"
          ? { type: "action" as const, action: { ...block.action, status: "error" as const, detail: "Stopped" } }
          : block);
        const nextBlocks = extractContent(cleaned) ? cleaned : appendTextBlock(cleaned, fallbackText);
        return { ...message, blocks: nextBlocks, content: message.content || fallbackText };
      };
      if (controller.signal.aborted) {
        setMessages((prev) => prev.map((message) => message.id === assistantId ? settle(message, "Response stopped. Any completed changes are saved.") : message));
      } else {
        notify((error as Error).message);
        if (!started) {
          if (regenerate) setMessages(snapshot);
          else {
            setMessages((prev) => prev.filter((message) => message.id !== userId && message.id !== assistantId));
            if (!preset) { setInput(text); setAttachments(files); }
          }
        }
        else setMessages((prev) => prev.map((message) => message.id === assistantId ? settle(message, (error as Error).message) : message));
      }
    } finally {
      setBusy(false); setStatus(""); abortRef.current = null; void refresh().catch(() => {});
      if (stickToBottomRef.current) requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const results: Attachment[] = [];
    for (const file of Array.from(list)) {
      if (attachments.length + results.length >= 3) { notify("A little less at once: up to 3 files per message."); break; }
      if (file.size > 2 * 1024 * 1024) { notify(`“${file.name}” is too big. Please keep each file under 2 MB.`); continue; }
      const image = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
      const text = /\.(txt|md|markdown|csv|json|log|html|css|js|ts|tsx|py|yaml|yml)$/i.test(file.name) || file.type.startsWith("text/");
      if (!image && !text) { notify("Please choose an image or text file (.txt, .md, .csv, .json, or code). PDFs aren’t supported yet."); continue; }
      try {
        const content = image ? await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }) : await file.text();
        if (!image && content.length > 200000) { notify("Text files need to be under 200,000 characters."); continue; }
        results.push({ id: crypto.randomUUID(), name: file.name, size: file.size, mime: file.type || "text/plain", type: image ? "image" : "text", content });
      } catch { notify(`Couldn’t read “${file.name}”. Please try another file.`); }
    }
    setAttachments((prev) => [...prev, ...results].slice(0, 3));
    if (fileRef.current) fileRef.current.value = "";
  };

  const toggleVoice = () => {
    if (listening) { voiceRef.current?.stop(); return; }
    const BrowserRecognition = (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition;
    if (!BrowserRecognition) { notify("Voice input isn’t supported in this browser. Try Chrome, or type your thought instead."); return; }
    const recognition = new BrowserRecognition(); voiceRef.current = recognition;
    recognition.lang = state.settings.language === "bn" ? "bn-BD" : state.settings.language === "en" ? "en-US" : navigator.language;
    recognition.interimResults = false; recognition.continuous = false;
    recognition.onresult = (event) => { const text = event.results[0]?.[0]?.transcript; if (text) setInput((prev) => prev + (prev ? " " : "") + text); };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => { setListening(false); notify(event.error === "not-allowed" ? "Microphone access wasn’t allowed. You can enable it in your browser settings." : "I couldn’t catch that. Please try again, or type your message."); };
    try { recognition.start(); setListening(true); } catch { setListening(false); notify("Couldn’t start voice input. Please try again."); }
  };

  const activeChat = state.conversations.find((chat) => chat.id === activeId);
  const visibleChats = state.conversations.filter((chat) => !chat.archived);
  const pinned = visibleChats.filter((chat) => chat.pinned);
  const recents = visibleChats.filter((chat) => !chat.pinned).slice(0, 7);
  const initials = state.settings.displayName ? state.settings.displayName.split(" ").map((word) => word[0]).slice(0, 2).join("").toUpperCase() : "Y";
  const composerProps = { input, onInput: setInput, attachments, onRemove: (id: string) => setAttachments((prev) => prev.filter((file) => file.id !== id)), onAttach: () => fileRef.current?.click(), onSend: () => void send(), busy, onStop: () => abortRef.current?.abort(), composerRef, mode, onMode: setMode, listening, onVoice: toggleVoice, onPreview: setPreview, engineLabel: state.engine.label };

  const renderRecent = (chat: Conversation) => <div className={`recent-row ${activeId === chat.id ? "active" : ""}`} key={chat.id}><button className="recent-main" onClick={() => void openChat(chat.id)} title={chat.title}>{chat.pinned ? <Pin size={13} /> : <MessageCircle size={14} />}<span>{chat.title}</span></button><ChatMenu chat={chat} onChange={(id, patch) => void changeChat(id, patch)} onRename={renameChat} onDelete={deleteChat} /></div>;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.settings.focusMode ? "focus-mode" : ""} ${state.settings.compactMode ? "compact-mode" : ""}`}>
    {mobileSidebar && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileSidebar(false)} />}
    <aside className={`sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
      <div className="sidebar-brand-row"><button className="brand-lockup" onClick={newChat} aria-label="Aura home"><AuraMark size={34} /><span>aura<span className="brand-period">.</span></span></button><IconButton label="Collapse sidebar" className="collapse-sidebar" onClick={() => { if (window.innerWidth <= 760) setMobileSidebar(false); else setSidebarCollapsed((prev) => !prev); }}><PanelLeftClose size={17} /></IconButton></div>
      <div className="sidebar-primary"><button className="new-chat-button" onClick={newChat}><Plus size={18} /><span>New conversation</span><kbd>⌘ K</kbd></button><button className="sidebar-nav-item" onClick={() => setPanel("history")} title="Search conversations"><Search size={18} /><span>Search conversations</span><kbd>⌘ /</kbd></button><button className="sidebar-nav-item" onClick={() => setPanel("tasks")} title="My tasks"><ListTodo size={18} /><span>My tasks</span>{state.tasks.some((task) => !task.completed) && <span className="nav-count">{state.tasks.filter((task) => !task.completed).length}</span>}</button><button className="sidebar-nav-item" onClick={() => setPanel("notes")} title="My notes"><FileText size={18} /><span>My notes</span>{state.notes.length > 0 && <span className="nav-count">{state.notes.length}</span>}</button><button className="sidebar-nav-item" onClick={() => setPanel("terminal")} title="Terminal"><Terminal size={18} /><span>Terminal</span></button><button className="sidebar-nav-item" onClick={() => setPanel("browser")} title="Browser"><Compass size={18} /><span>Browser</span></button><button className="sidebar-nav-item" onClick={() => setPanel("library")} title="Library"><Library size={18} /><span>Library</span>{(state.memories.length + state.events.length + state.bookmarks.length) > 0 && <span className="nav-count">{state.memories.length + state.events.length + state.bookmarks.length}</span>}</button><button className="sidebar-nav-item" onClick={() => setPanel("skills")} title="Skills"><Puzzle size={18} /><span>Skills</span></button></div>
      <div className="sidebar-conversations">
        {!!pinned.length && <><div className="sidebar-section-label">PINNED<Pin size={11} /></div><div className="recent-list pinned-list">{pinned.map(renderRecent)}</div></>}
        <div className="sidebar-section-label">RECENT CONVERSATIONS<button onClick={() => setPanel("history")} aria-label="View all conversations"><Clock3 size={13} /></button></div>
        <div className="recent-list">{recents.length ? recents.map(renderRecent) : <div className="sidebar-empty"><span>A fresh start, a little space.</span><p>Your conversations will find<br />a home here.</p></div>}</div>
        {visibleChats.length > 7 && <button className="see-all-chats" onClick={() => setPanel("history")}>See all conversations <ArrowRight size={13} /></button>}
      </div>
      <div className="sidebar-bottom">{showTip && <div className="sidebar-tip"><IconButton label="Dismiss introduction" className="dismiss-tip" onClick={() => { setShowTip(false); try { sessionStorage.setItem("aura-tip-dismissed", "true"); } catch { /* ignore */ } }}><X size={13} /></IconButton><OrbitArt /><div className="sidebar-tip-content"><h3>Big ideas.<br />Fewer tabs.</h3><p>A little help with the everyday.<br />A little room for what’s next.</p><button onClick={() => setPanel("help")}>Meet your new sidekick <ArrowUpRight size={14} /></button></div></div>}
        <button className="sidebar-nav-item bottom-nav-item" onClick={() => setPanel("help")} title="Help & shortcuts"><CircleHelp size={18} /><span>Help & shortcuts</span><span className="help-shortcut">?</span></button><button className="sidebar-nav-item bottom-nav-item" onClick={() => setPanel("settings")} title="Settings"><Settings2 size={18} /><span>Settings</span></button>
        <button className="profile-button" onClick={() => setPanel("settings")} title="Workspace preferences"><span className="avatar">{initials}</span><span className="profile-details"><strong>{state.settings.displayName || "Your workspace"}</strong><span>Personal space</span></span><ChevronsUpDown size={15} /></button>
      </div>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="topbar-left">{state.settings.focusMode ? <button className="exit-focus-button" onClick={() => void saveSettings({ focusMode: false }).catch((error) => notify(error.message))}><PanelLeftOpen size={17} /><span>Leave focus mode</span></button> : <IconButton label="Open navigation" className={`open-navigation ${sidebarCollapsed ? "show-on-desktop" : ""}`} onClick={() => { setSidebarCollapsed(false); setMobileSidebar(true); }}><PanelLeftOpen size={19} /></IconButton>}
        <button className="workspace-breadcrumb" onClick={() => setPanel("settings")}><Grid2X2 size={15} /><span>Personal workspace</span><ChevronDown size={13} /></button>{activeChat && <><span className="breadcrumb-separator">/</span><span className="topbar-chat-title">{activeChat.title}</span></>}
      </div><div className="topbar-right">{jobs.length > 0 && <button type="button" className={`bg-jobs-pill ${runningJobsCount ? "is-running" : ""}`} onClick={() => setJobsOpen(true)} title="Background tasks">{runningJobsCount ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}<span>{runningJobsCount ? `${runningJobsCount} running` : `${jobs.length} bg done`}</span></button>}{activeChat && <ChatMenu chat={activeChat} onChange={(id, patch) => void changeChat(id, patch)} onRename={renameChat} onDelete={deleteChat} />}<button className="agent-status" onClick={() => setPanel("settings")} title={`Backend AI engine: ${state.engine.label}. Workspace actions are instant.`}><span className={`status-dot ${!ready ? "connecting" : ""}`} />{ready ? "Agent ready" : "Connecting"}</button><span className="topbar-divider" /><IconButton label="What can Aura do?" onClick={() => setPanel("help")}><CircleHelp size={18} /></IconButton></div></header>

      {loadError && <div className="connection-error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button onClick={() => void refresh().catch((error) => setLoadError(error.message))}>Try again</button></div>}
      {loadingChat ? <div className="chat-loading"><AuraMark size={34} /><LoaderCircle size={19} className="spin" /><span>Picking up where you left off…</span></div> : !messages.length ? <div className="welcome-stage"><div className="welcome-content">
        <section className="hero-intro"><div className="hero-mark-wrap"><AuraMark size={49} /><span className="hero-sparkle">✦</span></div><p className="hero-eyebrow">{state.settings.displayName ? `A LITTLE MORE HEADSPACE, ${state.settings.displayName.toUpperCase()}` : "A LITTLE MORE HEADSPACE"}</p><h1>Less busywork.<br /><em>More possibility.</em></h1><p className="hero-description">From your first thought to your next big thing.<br />One conversation is all it takes.</p></section>
        <Composer {...composerProps} />
        {state.settings.showSuggestions && <section className="suggestions"><div className="suggestions-heading"><h2>A FEW PLACES TO START</h2><button onClick={() => setIdeas((prev) => (prev + 1) % suggestionSets.length)}><Shuffle size={12} />A little more inspiration</button></div><div className="suggestion-grid">{suggestionSets[ideas].map(({ icon: Icon, color, title, description, prompt }) => <button className="suggestion-card" key={`${ideas}-${title}`} onClick={() => usePrompt(prompt)}><div className="suggestion-card-top"><span className={`suggestion-icon ${color}`}><Icon size={18} strokeWidth={1.6} /></span><ArrowUpRight size={16} className="suggestion-arrow" /></div><h3>{title}</h3><p>{description}</p></button>)}</div></section>}
        <button className="possibilities-link" onClick={() => setPanel("help")}><Sparkles size={14} /><span>A little curious? <strong>See what Aura can do</strong></span><ArrowUpRight size={13} /></button>
      </div><footer className="welcome-footer"><span><Leaf size={13} />Less menus. More momentum.</span><button onClick={() => setPanel("settings")}><LockKeyhole size={12} />Your workspace. Your rules.</button></footer></div> : <div className="chat-stage"><div ref={messagesScrollRef} className="messages-scroll" onScroll={handleMessagesScroll} onWheel={handleMessagesWheel}><div className="messages-content">
        <div className="conversation-date"><span />{relativeDate(messages[0].createdAt)}<span /></div>
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          return <article className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`} key={message.clientId ?? message.id}>
            {message.role === "user" ? <div className="user-message-content">{!!message.attachments.length && <div className="message-attachments">{message.attachments.map((file) => <button key={file.id} onClick={() => setPreview(file)} className={file.type === "image" ? "image-attachment" : "file-attachment"}>{file.type === "image" ? <img src={file.content} alt={file.name} /> : <><FileText size={18} /><span>{file.name}</span></>}</button>)}</div>}{message.content && <div className="user-bubble">{message.content}</div>}{message.content && <div className="user-tools"><button type="button" onClick={() => copyText(message.content)} aria-label="Copy message" title="Copy message"><Copy size={12} /></button><button type="button" onClick={() => usePrompt(message.content)} aria-label="Edit and reuse this message" title="Edit and reuse"><Pencil size={12} /></button></div>}</div>
            : <AssistantReply message={message} streaming={busy && isLast} status={status} isLast={isLast} busy={busy} tasks={state.tasks} speaking={speakingId === message.id}
                canRegenerate={isLast && !busy && message.actions.length === 0 && index > 0 && messages[index - 1].role === "user"}
                onOpenAction={takeAction} onToggleTask={toggleTask} onCopy={copyText} onSpeak={() => speak(message)} onSaveNote={(text) => void saveReplyAsNote(text)}
                onRegenerate={() => void send({ regenerate: true })} onFeedback={(value) => void sendFeedback(message.id, value)} onFollowUp={(text) => void send({ text })} />}
          </article>;
        })}<div ref={scrollEndRef} className="scroll-end" />
      </div></div>{showJumpToBottom && <button type="button" className="jump-to-bottom" onClick={jumpToBottom} aria-label="Scroll to latest message"><ArrowDown size={14} /><span>{busy ? "Follow live output" : "Jump to latest"}</span></button>}<div className="composer-dock"><Composer {...composerProps} /></div></div>}
    </main>
    <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.json,.log,.html,.css,.js,.ts,.tsx,.py,.yaml,.yml" hidden onChange={(event) => void addFiles(event.target.files)} />

    <WorkspacePanels panel={panel} state={state} onClose={closePanel} onSettings={saveSettings} onItem={async (method, payload) => { await api("/api/items", { method, body: JSON.stringify(payload) }); await refresh(); }} onOpenChat={(id) => void openChat(id)} onChangeChat={(id, patch) => void changeChat(id, patch)} onRename={renameChat} onDeleteChat={deleteChat} onConfirm={setConfirm} onPrompt={usePrompt} onNotify={notify} />
    {confirm && <Modal title={confirm.title} onClose={closeConfirm} className="confirmation-modal"><p className="confirmation-description">{confirm.detail}</p><div className="confirmation-buttons"><button className="secondary-button" onClick={closeConfirm} disabled={confirmBusy}>Keep it</button><button className="danger-button" disabled={confirmBusy} onClick={async () => { setConfirmBusy(true); try { await confirm.action(); setConfirm(null); } catch (error) { notify((error as Error).message); } finally { setConfirmBusy(false); } }}>{confirmBusy ? <LoaderCircle size={15} className="spin" /> : <X size={15} />}Delete permanently</button></div></Modal>}
    {rename && <Modal title="A name to come back to" onClose={closeRename} className="rename-modal"><form onSubmit={async (event) => { event.preventDefault(); if (!renameValue.trim()) return; await changeChat(rename.id, { title: renameValue }); setRename(null); }}><label className="field-label" htmlFor="rename-chat">Conversation name</label><input id="rename-chat" data-autofocus className="text-input" value={renameValue} maxLength={160} onChange={(event) => setRenameValue(event.target.value)} /><div className="confirmation-buttons"><button className="secondary-button" type="button" onClick={closeRename}>Cancel</button><button className="primary-button" disabled={!renameValue.trim()}><Check size={15} />Save name</button></div></form></Modal>}
    {preview && <Modal title={preview.name} onClose={closePreview} className="preview-modal">{preview.type === "image" ? <img className="image-preview" src={preview.content} alt={preview.name} /> : <pre className="text-preview">{preview.content}</pre>}<a className="secondary-button attachment-download" download={preview.name} href={preview.type === "image" ? preview.content : `data:text/plain;charset=utf-8,${encodeURIComponent(preview.content)}`}><ArrowDownToLine size={15} />Download file</a></Modal>}
    {jobsOpen && <Modal drawer title="Background tasks" subtitle="Actions running while you keep chatting." onClose={() => setJobsOpen(false)} className="jobs-panel">
      <div className="drawer-body">
        {jobs.length > 0 && jobs.some((j) => j.status !== "running") && <div className="jobs-bar"><button type="button" className="text-button" onClick={() => void removeJob()}>Clear finished</button></div>}
        <div className="jobs-list">{!jobs.length ? <p className="setting-explainer">No background tasks right now. Ask Aura to run an image, research, or specialist task in the background while you keep working.</p> : jobs.map((job) => <article key={job.id} className={`job-card ${job.status}`}>
          <div className="job-head">
            <span className="job-status-ico">{job.status === "running" ? <LoaderCircle size={14} className="spin" /> : job.status === "error" ? <CircleAlert size={14} /> : <Check size={14} />}</span>
            <span className="job-meta"><strong>{job.label}</strong><small>{job.detail}</small></span>
            <IconButton label={job.status === "running" ? "Cancel task" : "Dismiss"} onClick={() => void removeJob(job.id)}><X size={14} /></IconButton>
          </div>
          {job.image && <img className="skill-image" src={job.image} alt={job.label} />}
          {job.output && <pre className="web-step-output">{job.output}</pre>}
        </article>)}</div>
      </div>
    </Modal>}
    {toast && <div className="toast" role="status"><AuraMark size={20} /><span>{toast}</span><IconButton label="Dismiss notification" onClick={() => setToast("")}><X size={15} /></IconButton></div>}
  </div>;
}

const slashCommands = [
  { name: "task", hint: "Add a task, with an optional due date", insert: "Create tasks: " },
  { name: "note", hint: "Save a note", insert: "Save a note: " },
  { name: "tasks", hint: "Show my task list", insert: "Show my tasks" },
  { name: "notes", hint: "Show my notes", insert: "Show my notes" },
  { name: "terminal", hint: "Work in the private terminal", insert: "Use the terminal to " },
  { name: "calc", hint: "Calculate exactly", insert: "Calculate " },
  { name: "time", hint: "Current time in any city", insert: "What time is it in " },
  { name: "web", hint: "Read a public web page", insert: "Read this page and summarize it: https://" },
  { name: "search", hint: "Search the web and read the best pages", insert: "Search the web for " },
  { name: "weather", hint: "Forecast for any city", insert: "What's the weather in " },
  { name: "translate", hint: "Translate into another language", insert: "Translate  to Bengali" },
  { name: "define", hint: "Dictionary meaning", insert: "Define " },
  { name: "wiki", hint: "Wikipedia summary", insert: "Tell me about " },
  { name: "news", hint: "Fresh tech headlines", insert: "Latest AI news" },
  { name: "currency", hint: "Convert money", insert: "Convert 100 USD to BDT" },
  { name: "crypto", hint: "Live coin prices", insert: "Price of bitcoin and ethereum" },
  { name: "unit", hint: "Convert units", insert: "Convert 5 km to miles" },
  { name: "qr", hint: "Make a QR code", insert: "Make a QR code for " },
  { name: "image", hint: "Generate an AI image", insert: "Generate an image of " },
  { name: "remember", hint: "Teach Aura a lasting fact", insert: "Remember that " },
  { name: "event", hint: "Save a dated event", insert: "Add an event: " },
  { name: "bookmark", hint: "Save a link", insert: "Bookmark https://" },
  { name: "bg", hint: "Run a task in the background while chatting", insert: "Run in the background: " },
  { name: "hire", hint: "Delegate to a specialist agent", insert: "Hire the " },
  { name: "team", hint: "Meet your agent team", insert: "Who is on your team?" },
  { name: "coder", hint: "Code, data, algorithms", insert: "Ask the coder to " },
  { name: "research", hint: "Deep cited research", insert: "Ask the researcher to " },
  { name: "design", hint: "AI images and QR codes", insert: "Ask the designer to " },
  { name: "video", hint: "Script, scenes, slideshow", insert: "Ask the video creator to " },
  { name: "write", hint: "Draft and save documents", insert: "Ask the writer to " },
  { name: "focus", hint: "Turn on focus mode", insert: "Turn on focus mode" },
  { name: "dark", hint: "Switch to the dark theme", insert: "Switch to dark mode" },
  { name: "light", hint: "Switch to the light theme", insert: "Switch to light mode" },
];

type ComposerProps = {
  input: string; onInput: (value: string) => void; attachments: Attachment[]; onRemove: (id: string) => void;
  onAttach: () => void; onSend: () => void; busy: boolean; onStop: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  mode: "auto" | "workspace" | "plan"; onMode: (value: "auto" | "workspace" | "plan") => void;
  listening: boolean; onVoice: () => void; onPreview: (file: Attachment) => void; engineLabel: string;
};
function Composer(props: ComposerProps) {
  const modeRef = useRef<HTMLDetailsElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState("");
  const slashQuery = /^\/([a-z]*)$/i.exec(props.input)?.[1]?.toLowerCase();
  const slashMatches = slashQuery !== undefined && slashDismissed !== props.input && !props.busy ? slashCommands.filter((command) => command.name.startsWith(slashQuery)) : [];
  const activeSlash = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  const chooseSlash = (index: number) => {
    const command = slashMatches[index];
    if (!command) return;
    props.onInput(command.insert);
    setSlashIndex(0);
    requestAnimationFrame(() => { const el = props.composerRef.current; if (el) { el.focus(); el.setSelectionRange(command.insert.length, command.insert.length); } });
  };
  useEffect(() => { const input = props.composerRef.current; if (input) { input.style.height = "auto"; input.style.height = `${Math.min(180, Math.max(55, input.scrollHeight))}px`; } }, [props.input, props.composerRef]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (modeRef.current && !modeRef.current.contains(event.target as Node)) modeRef.current.open = false; };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);
  return <div className="composer-area"><div className={`composer ${props.listening ? "is-listening" : ""}`}>
    {!!props.attachments.length && <div className="composer-attachments">{props.attachments.map((file) => <div className="composer-file" key={file.id}><button onClick={() => props.onPreview(file)}>{file.type === "image" ? <img src={file.content} alt="" /> : <FileText size={18} />}<span>{file.name}<small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span></button><IconButton label={`Remove ${file.name}`} onClick={() => props.onRemove(file.id)}><X size={13} /></IconButton></div>)}</div>}
    {slashMatches.length > 0 && <div className="slash-menu" role="listbox" aria-label="Commands">
      <p>Commands <span>↑↓ to move · Enter to pick · Esc to close</span></p>
      {slashMatches.map((command, index) => <button type="button" role="option" aria-selected={index === activeSlash} key={command.name} className={index === activeSlash ? "active" : ""} onMouseEnter={() => setSlashIndex(index)} onClick={() => chooseSlash(index)}><strong>/{command.name}</strong><span>{command.hint}</span></button>)}
    </div>}
    <textarea ref={props.composerRef} aria-label="Message Aura" placeholder={props.listening ? "I’m listening. Take your time…" : "A question, a task, an idea… or type / for commands"} value={props.input} maxLength={20000} rows={2} onChange={(event) => props.onInput(event.target.value)} onKeyDown={(event) => {
      if (slashMatches.length) {
        if (event.key === "ArrowDown") { event.preventDefault(); setSlashIndex((activeSlash + 1) % slashMatches.length); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((activeSlash - 1 + slashMatches.length) % slashMatches.length); return; }
        if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) { event.preventDefault(); chooseSlash(activeSlash); return; }
        if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(props.input); return; }
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); props.onSend(); }
    }} />
    <div className="composer-toolbar"><div className="composer-tools-left"><button className="attach-button" onClick={props.onAttach} title="Attach images or text files (up to 3, 2 MB each)" aria-label="Attach images or text files" disabled={props.busy}><Plus size={19} /></button><span className="composer-tool-divider" /><details className="mode-selector" ref={modeRef}><summary><AuraMark size={15} /><span>{props.mode === "auto" ? "Aura auto" : props.mode === "plan" ? "Plan first" : "Workspace"}</span><ChevronDown size={12} /></summary><div className="mode-menu"><button onClick={() => { props.onMode("auto"); if (modeRef.current) modeRef.current.open = false; }}><Sparkles size={17} /><span><strong>Aura auto</strong><small>{props.engineLabel} · reasoning + workspace actions</small></span>{props.mode === "auto" && <Check size={15} />}</button><button onClick={() => { props.onMode("plan"); if (modeRef.current) modeRef.current.open = false; }}><ListChecks size={17} /><span><strong>Plan first</strong><small>Draft a checklist, tick each step as it works.</small></span>{props.mode === "plan" && <Check size={15} />}</button><button onClick={() => { props.onMode("workspace"); if (modeRef.current) modeRef.current.open = false; }}><LockKeyhole size={17} /><span><strong>Workspace only</strong><small>Built-in commands. No AI requests.</small></span>{props.mode === "workspace" && <Check size={15} />}</button></div></details></div>
      <div className="composer-tools-right">{props.input.length > 19000 && <span className="character-count">{props.input.length}/20,000</span>}<IconButton label={props.listening ? "Stop voice input" : "Use voice input"} className={props.listening ? "voice-button active" : "voice-button"} onClick={props.onVoice} disabled={props.busy}><Mic size={18} /></IconButton>{props.busy ? <button className="send-button stop-button" aria-label="Stop response" title="Stop response" onClick={props.onStop}><Square size={15} fill="currentColor" /></button> : <button className={`send-button ${props.input.trim() || props.attachments.length ? "has-content" : ""}`} aria-label="Send message" title="Send message" onClick={props.onSend} disabled={!props.input.trim() && !props.attachments.length}><ArrowUp size={21} strokeWidth={1.8} /></button>}</div>
    </div>
  </div><div className="composer-caption"><span><ShieldCheck size={12} />A little intelligence. Always in your control.</span><span className="enter-hint"><kbd>↵</kbd> to send</span></div></div>;
}
