"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, ArrowRight, Bookmark, Bot, ListChecks, Brain, CalendarClock, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, FileText, Fingerprint, Keyboard, KeyRound, Laptop, Leaf, ListTodo, LoaderCircle, LockKeyhole, MessageCircle, Moon, Pencil, Plus, Puzzle, Search, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Trash2, Terminal, Compass, Users, WandSparkles, X, RefreshCw, CircleAlert, Globe } from "lucide-react";
import { AuraMark } from "@/components/brand";
import { TaskBadges } from "@/components/agent-step";
import { SKILL_CATALOG } from "@/lib/skills-catalog";
import { ChatMenu, EmptyState, IconButton, Modal, Toggle } from "@/components/ui";
import { api, relativeDate } from "@/lib/client";
import type { Conversation, Panel, Settings, WorkspaceState } from "@/lib/types";

type ItemPayload = { kind: "task" | "note" | "memory" | "event" | "bookmark"; id?: string; title?: string; content?: string; completed?: boolean; due?: string | null; priority?: "low" | "normal" | "high"; fact?: string; date?: string; notes?: string; url?: string };
export type ConfirmRequest = { title: string; detail: string; action: () => Promise<void> };
export type PanelProps = {
  panel: Panel;
  state: WorkspaceState;
  onClose: () => void;
  onSettings: (patch: Partial<Settings>) => Promise<void>;
  onItem: (method: "POST" | "PATCH" | "DELETE", payload: ItemPayload) => Promise<void>;
  onOpenChat: (id: string) => void;
  onChangeChat: (id: string, patch: Partial<Conversation>) => void;
  onRename: (chat: Conversation) => void;
  onDeleteChat: (chat: Conversation) => void;
  onConfirm: (request: ConfirmRequest) => void;
  onPrompt: (text: string) => void;
  onNotify: (text: string) => void;
};

export default function WorkspacePanels(props: PanelProps) {
  if (props.panel === "settings") return <SettingsPanel {...props} />;
  if (props.panel === "history") return <HistoryPanel {...props} />;
  if (props.panel === "tasks") return <TasksPanel {...props} />;
  if (props.panel === "notes") return <NotesPanel {...props} />;
  if (props.panel === "help") return <HelpPanel {...props} />;
  if (props.panel === "terminal") return <TerminalPanel {...props} />;
  if (props.panel === "browser") return <BrowserPanel {...props} />;
  if (props.panel === "library") return <LibraryPanel {...props} />;
  if (props.panel === "skills") return <SkillsPanel {...props} />;
  return null;
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="setting-row"><div><h4>{title}</h4>{description && <p>{description}</p>}</div>{children}</div>;
}

function SettingsPanel({ state, onClose, onSettings, onNotify }: PanelProps) {
  const [tab, setTab] = useState("general");
  const [name, setName] = useState(state.settings.displayName);
  const [saving, setSaving] = useState(false);
  const change = async (patch: Partial<Settings>) => {
    setSaving(true);
    try { await onSettings(patch); } catch (error) { onNotify((error as Error).message); } finally { setSaving(false); }
  };
  const tabs = [
    { id: "general", name: "General", icon: Settings2 },
    { id: "intelligence", name: "AI engine", icon: Server },
    { id: "personalization", name: "Personalization", icon: Fingerprint },
    { id: "data", name: "Data & privacy", icon: ShieldCheck },
  ];
  return <Modal title="Make yourself at home" subtitle="A few preferences. A workspace that feels like you." onClose={onClose} className="settings-modal">
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">
      {tabs.map(({ id, name: label, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={17} />{label}</button>)}
      <div className="settings-brand"><AuraMark size={23} /><span>aura<span>A little more headspace.</span></span></div>
    </nav><div className="settings-content">
      {tab === "general" && <><div className="section-heading"><h3>The everyday details</h3><p>Small touches that make a big difference.</p></div>
        <label className="field-label" htmlFor="display-name">What should I call you?</label><input id="display-name" className="text-input" placeholder="Your name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name !== state.settings.displayName) void change({ displayName: name }); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <h4 className="field-label appearance-label">Appearance</h4><div className="theme-options">{[{ id: "light", label: "Light", icon: Sun }, { id: "dark", label: "Dark", icon: Moon }, { id: "system", label: "System", icon: Laptop }].map(({ id, label, icon: Icon }) => <button key={id} disabled={saving} className={`theme-option ${state.settings.theme === id ? "selected" : ""}`} onClick={() => void change({ theme: id as Settings["theme"] })}><Icon size={20} /><span>{label}</span>{state.settings.theme === id && <Check className="theme-check" size={12} />}</button>)}</div>
        <SettingRow title="Focus mode" description="Less sidebar. More room for your thoughts."><Toggle label="Focus mode" checked={state.settings.focusMode} disabled={saving} onChange={(focusMode) => void change({ focusMode })} /></SettingRow>
        <SettingRow title="Compact conversations" description="Keep things a little closer together."><Toggle label="Compact conversations" checked={state.settings.compactMode} disabled={saving} onChange={(compactMode) => void change({ compactMode })} /></SettingRow>
        <SettingRow title="A little inspiration" description="Show prompt ideas on your new chat screen."><Toggle label="Show prompt suggestions" checked={state.settings.showSuggestions} disabled={saving} onChange={(showSuggestions) => void change({ showSuggestions })} /></SettingRow>
        <SettingRow title="Plan before acting" description="For multi-step work, Aura drafts a checklist and ticks each step as it goes."><select className="text-input planning-select" aria-label="Planning mode" value={state.settings.planning} disabled={saving} onChange={(e) => void change({ planning: e.target.value as Settings["planning"] })}><option value="auto">Auto — plan when it helps</option><option value="always">Always plan</option><option value="off">Never plan</option></select></SettingRow>
        <SettingRow title="Reply sounds" description="A soft chime when your answer is ready."><Toggle label="Reply sounds" checked={state.settings.sound} disabled={saving} onChange={(sound) => void change({ sound })} /></SettingRow>
      </>}
      {tab === "intelligence" && <><div className="section-heading"><h3>A brain behind the scenes</h3><p>The intelligence runs on Aura’s backend. There is nothing for you to configure or paste.</p></div>
        <div className="connection-card connected"><div className="connection-symbol"><Brain size={21} /></div><div><h4>{state.engine.label}</h4><p><span className="status-dot" />Running on the server</p></div><ShieldCheck size={19} className="green-text" /></div>
        <div className="setting-row engine-model-row"><div><h4>Active model</h4><p>{state.engine.model}</p></div><span className="engine-badge">{state.engine.keyless ? "Free backend" : "Server engine"}</span></div>
        {state.engine.keyless ? <div className="privacy-callout"><Clock3 size={17} /><p><strong>Free backend engines, built for speed.</strong> Aura rotates across several verified engines and starts a second one whenever the first is slow, so replies usually begin within a couple of seconds. Each free engine allows about two requests a minute; if every one is resting, Aura shows the exact countdown instead of faking a reply. Everyday commands are instant and never wait for a model.</p></div> : <div className="privacy-callout"><Sparkles size={17} /><p>{state.engine.note}</p></div>}
        <div className="privacy-feature"><div>{state.engine.vision ? <Sparkles size={20} /> : <FileText size={20} />}</div><section><h4>{state.engine.vision ? "Images are understood" : "Text and code files"}</h4><p>{state.engine.vision ? "The engine can interpret images you attach, alongside your text files." : "This engine reads messages, notes, and text or code files. It cannot see images yet, and will say so instead of guessing at them."}</p></section></div>
        <div className="privacy-feature"><div><LockKeyhole size={20} /></div><section><h4>No keys in your browser</h4><p>You are never asked for an API key. Requests pass through Aura’s backend, and no credential is stored in the app’s database or sent to your browser.</p></section></div>
        <div className="privacy-feature"><div><Server size={20} /></div><section><h4>Built to run on your own machine</h4><p>When deploying, connect a self-hosted OpenAI-compatible model with <code>AURA_AI_BASE_URL</code> and <code>AURA_AI_MODEL</code>, or configure another provider in server environment variables. The interface stays the same.</p></section></div>
        <div className="privacy-feature"><div><Search size={20} /></div><section><h4>Fresh web search, with optional Google</h4><p>Time-sensitive searches already lead with dated headlines from Google News and Bing News, plus full articles from FreeSerp and DuckDuckGo — no key needed. To turn it into true Google SERP coverage, set <code>SERPER_API_KEY</code> (or <code>BRAVE_API_KEY</code> / <code>TAVILY_API_KEY</code>) in the server environment; Aura will use it automatically and say so in the source line.</p></section></div>
        <div className="gentle-tip"><WandSparkles size={18} /><p>Workspace actions are handled separately from the model, so they stay instant even while the free engine is cooling down.</p></div>
      </>}
      {tab === "personalization" && <><div className="section-heading"><h3>On your wavelength</h3><p>Tell Aura how you like to think and work.</p></div>
        <SettingRow title="Workspace memory" description="Use saved tasks and notes as context for AI replies."><Toggle label="Workspace memory" checked={state.settings.memory} disabled={saving} onChange={(memory) => void change({ memory })} /></SettingRow>
        <label className="field-label spaced-label" htmlFor="response-style">Response length</label><select id="response-style" className="text-input" value={state.settings.responseStyle} disabled={saving} onChange={(e) => void change({ responseStyle: e.target.value as Settings["responseStyle"] })}><option value="concise">Short & sweet</option><option value="balanced">A happy medium</option><option value="detailed">All the details</option></select>
        <label className="field-label spaced-label" htmlFor="language">Conversation language</label><select id="language" className="text-input" value={state.settings.language} disabled={saving} onChange={(e) => void change({ language: e.target.value as Settings["language"] })}><option value="auto">Match my message</option><option value="en">English</option><option value="bn">বাংলা</option></select>
        <div className="gentle-tip"><WandSparkles size={18} /><p>Skip the settings next time. Just say <strong>“Keep your replies concise”</strong> or <strong>“Call me Alex.”</strong></p></div>
      </>}
      {tab === "data" && <><div className="section-heading"><h3>Yours, and only yours</h3><p>Your ideas deserve a little peace of mind.</p></div>
        <div className="privacy-feature"><div><Server size={20} /></div><section><h4>Runs on the server, always</h4><p>Chats, files, tasks, and background jobs live on the Aura server and in PostgreSQL — closing this tab never stops work. To host it yourself 24/7, see the README's "Run 24/7 on your own cloud" section (VPS with systemd, or Vercel/Railway/Fly.io).</p></section></div>
        <div className="privacy-feature"><div><ShieldCheck size={20} /></div><section><h4>A private workspace</h4><p>Your history, notes, and tasks are stored in PostgreSQL and tied to a private browser cookie. They are not a public feed.</p></section></div>
        <div className="privacy-feature"><div><LockKeyhole size={20} /></div><section><h4>No invisible connections</h4><p>AI replies send relevant conversation content through Aura’s backend to the engine provider. Choose “Workspace only” in the composer for built-in commands with no AI request at all.</p></section></div>
        <div className="privacy-feature"><div><ArrowDownToLine size={20} /></div><section><h4>Take your ideas with you</h4><p>Download all your conversations, attachments, tasks, notes, and preferences as JSON. No API keys exist in this app to include.</p><a className="secondary-button export-button" href="/api/export" download><ArrowDownToLine size={15} />Export workspace</a></section></div>
        <div className="privacy-callout"><CircleHelp size={17} /><p>This is a browser-based workspace, not an account login. Clearing your cookies removes access. Export anything important before changing browsers.</p></div>
      </>}
    </div></div>
  </Modal>;
}

function HistoryPanel(props: PanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [results, setResults] = useState<Conversation[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!query.trim()) { setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api<Conversation[]>(`/api/conversations?q=${encodeURIComponent(query)}`, { signal: controller.signal }).then(setResults).catch((error) => { if (error.name !== "AbortError") props.onNotify(error.message); }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, props.state.conversations, props.onNotify]);
  const all = query.trim() ? results : props.state.conversations;
  const chats = all.filter((c) => filter === "archived" ? c.archived : filter === "pinned" ? c.pinned && !c.archived : !c.archived);
  return <Modal title="A thought worth coming back to" subtitle="Every conversation, right where you left it." onClose={props.onClose} className="history-modal">
    <div className="history-search"><Search size={19} /><input data-autofocus placeholder="Search your conversations…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search conversations" />{searching ? <LoaderCircle size={16} className="spin" /> : query && <IconButton label="Clear search" onClick={() => setQuery("")}><X size={15} /></IconButton>}</div>
    <div className="filter-tabs">{["all", "pinned", "archived"].map((f) => <button key={f} className={f === filter ? "active" : ""} onClick={() => setFilter(f)}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>)}<span>{chats.length} conversations</span></div>
    <div className="history-list">{!chats.length ? <EmptyState icon={<Clock3 size={25} />} title={query ? "No matching conversations" : "A fresh page awaits"}>{query ? "Try a different word. We search messages, too." : "Your conversations will appear here as you chat."}</EmptyState> : chats.map((chat) => <div className="history-row" key={chat.id}><div className="history-chat-icon"><MessageCircle size={18} /></div><button className="history-row-main" onClick={() => props.onOpenChat(chat.id)}><strong>{chat.title}</strong><span>{relativeDate(chat.updatedAt)}{chat.pinned && " · Pinned"}</span></button><ChatMenu chat={chat} onChange={props.onChangeChat} onRename={props.onRename} onDelete={props.onDeleteChat} /></div>)}</div>
    <div className="modal-bottom-note"><LockKeyhole size={13} />Just your thoughts. Just your workspace.</div>
  </Modal>;
}

function TasksPanel(props: PanelProps) {
  const [value, setValue] = useState("");
  const [filter, setFilter] = useState("open");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const items = props.state.tasks.filter((task) => filter === "all" || (filter === "done" ? task.completed : !task.completed));
  const act = async (method: "POST" | "PATCH" | "DELETE", data: ItemPayload) => { setBusy(true); try { await props.onItem(method, data); return true; } catch (error) { props.onNotify((error as Error).message); return false; } finally { setBusy(false); } };
  return <Modal drawer title="A little forward motion" subtitle="One less thing to keep in your head." onClose={props.onClose} className="tasks-panel">
    <div className="drawer-body"><div className="task-overview"><div className="overview-icon"><ListTodo size={22} /></div><div><strong>{props.state.tasks.filter((t) => !t.completed).length}</strong><span>things on your plate</span></div><span className="done-count"><CheckCheck size={14} />{props.state.tasks.filter((t) => t.completed).length} done</span></div>
      <form className="add-task-form" onSubmit={async (e) => { e.preventDefault(); if (value.trim() && await act("POST", { kind: "task", title: value, ...(due ? { due } : {}) })) { setValue(""); setDue(""); } }}><Plus size={18} /><input value={value} maxLength={300} onChange={(e) => setValue(e.target.value)} placeholder="What needs a little attention?" aria-label="New task title" /><input type="date" className="task-date-input" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date (optional)" title="Due date (optional)" /><button disabled={busy || !value.trim()} aria-label="Add task"><ArrowRight size={17} /></button></form>
      <div className="filter-tabs task-filters">{["open", "done", "all"].map((f) => <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>)}</div>
      <div className="task-list">{!items.length ? <EmptyState icon={<Leaf size={27} />} title={filter === "done" ? "Good things take a first step" : "A little room to breathe"}>{filter === "done" ? "Completed tasks will find a home here." : "Add a task above, or just tell Aura what needs doing."}</EmptyState> : items.map((task) => <div className={`task-row ${task.completed ? "completed" : ""}`} key={task.id}><button className="task-checkbox" aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`} disabled={busy} onClick={() => void act("PATCH", { kind: "task", id: task.id, completed: !task.completed })}>{task.completed && <Check size={12} />}</button>
        {editing?.id === task.id ? <form className="task-edit-form" onSubmit={async (e) => { e.preventDefault(); if (editing.title.trim() && await act("PATCH", { kind: "task", id: task.id, title: editing.title })) setEditing(null); }}><input autoFocus value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} /><button className="icon-button" aria-label="Save task" disabled={busy}><Check size={15} /></button></form> : <span className="task-title">{task.title}<TaskBadges task={task} /></span>}
        <div className="item-actions"><IconButton label="Edit task" onClick={() => setEditing({ id: task.id, title: task.title })}><Pencil size={14} /></IconButton><IconButton label="Delete task" onClick={() => props.onConfirm({ title: "Let this task go?", detail: `“${task.title}” will be permanently deleted.`, action: async () => { await props.onItem("DELETE", { kind: "task", id: task.id }); } })}><Trash2 size={14} /></IconButton></div>
      </div>)}</div>
    </div><div className="drawer-tip"><Sparkles size={16} /><span>Or just say, <strong>“Add task: finish the proposal”</strong></span></div>
  </Modal>;
}

function NotesPanel(props: PanelProps) {
  const [editor, setEditor] = useState<{ id?: string; title: string; content: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <Modal drawer title="A home for your thoughts" subtitle="Ideas, details, and little things worth keeping." onClose={props.onClose} className="notes-panel"><div className="drawer-body">
    {!editor ? <button className="secondary-button new-note-button" onClick={() => setEditor({ title: "", content: "" })}><Plus size={17} />A new note</button> : <form className="note-editor" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await props.onItem(editor.id ? "PATCH" : "POST", { kind: "note", ...editor }); setEditor(null); } catch (error) { props.onNotify((error as Error).message); } finally { setBusy(false); } }}><input autoFocus className="note-title-input" placeholder="Give your thought a title" value={editor.title} maxLength={300} onChange={(e) => setEditor({ ...editor, title: e.target.value })} aria-label="Note title" /><textarea placeholder="A little idea goes a long way…" value={editor.content} maxLength={30000} onChange={(e) => setEditor({ ...editor, content: e.target.value })} aria-label="Note content" /><div><button type="button" className="text-button" onClick={() => setEditor(null)}>Cancel</button><button className="primary-button" disabled={busy || !editor.title.trim() || !editor.content.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save note</button></div></form>}
    <p className="list-section-label">YOUR NOTES <span>{props.state.notes.length}</span></p>
    <div className="notes-list">{!props.state.notes.length ? <EmptyState icon={<FileText size={27} />} title="Give that thought a home">Save a spark of inspiration, a useful detail, or a plan for later.</EmptyState> : props.state.notes.map((note) => <article className={`note-card ${expanded === note.id ? "expanded" : ""}`} key={note.id}><button className="note-card-main" onClick={() => setExpanded(expanded === note.id ? null : note.id)}><div><FileText size={17} /><span>{relativeDate(note.createdAt)}</span><ChevronRight size={16} /></div><h3>{note.title}</h3><p>{note.content}</p></button>{expanded === note.id && <div className="note-card-actions"><button className="text-button" onClick={() => setEditor({ id: note.id, title: note.title, content: note.content })}><Pencil size={13} />Edit note</button><button className="text-button danger-text" onClick={() => props.onConfirm({ title: "Let this note go?", detail: `“${note.title}” will be permanently deleted. This cannot be undone.`, action: async () => { await props.onItem("DELETE", { kind: "note", id: note.id }); } })}><Trash2 size={13} />Delete</button></div>}</article>)}</div>
  </div><div className="drawer-tip"><Sparkles size={16} /><span>Or tell Aura, <strong>“Save a note: my next big idea…”</strong></span></div></Modal>;
}

function HelpPanel(props: PanelProps) {
  const ideas = [
    { icon: ListTodo, color: "sage", title: "A clearer to-do list", text: "Create tasks, check things off, keep moving.", prompt: "Create tasks: plan the week, review my priorities, make time for a walk" },
    { icon: FileText, color: "peach", title: "A place for the little things", text: "Save ideas and find them when you need them.", prompt: "Save a note: Good ideas need a little room to grow." },
    { icon: SlidersHorizontal, color: "lavender", title: "Your space, your way", text: "Change your preferences without the menus.", prompt: "Turn on focus mode" },
    { icon: ListChecks, color: "butter", title: "Plans you can watch", text: "It drafts a checklist first, then ticks each step as it works.", prompt: "Plan first: plan my product launch for next month" },
    { icon: Brain, color: "butter", title: "A thinking partner", text: `Write, brainstorm, and untangle an idea on ${props.state.engine.label}.`, prompt: "Help me turn a half-formed idea into a clear plan. Ask me a few questions to get started." },
    { icon: Users, color: "sage", title: "A team of specialists", text: "A coder, researcher, designer, video creator, and writer on call.", prompt: "Who is on your team?" },
    { icon: Bot, color: "peach", title: "Delegate real work", text: "Hand a focused job to the right specialist.", prompt: "Ask the coder to compute the first 10 Fibonacci numbers" },
  ];
  return <Modal title="A little help goes a long way" subtitle="One conversation. A whole lot of possibility." onClose={props.onClose} className="help-modal"><div className="help-intro"><div className="help-aura-mark"><AuraMark size={35} /></div><p>No maze of menus. Tell Aura what you need, and let your agent connect the dots.</p></div><div className="capability-grid">{ideas.map(({ icon: Icon, color, title, text, prompt }) => <button key={title} onClick={() => props.onPrompt(prompt)}><span className={`capability-icon ${color}`}><Icon size={20} /></span><h3>{title}</h3><p>{text}</p><ArrowRight size={16} className="capability-arrow" /></button>)}</div><div className="shortcuts"><h4><Keyboard size={16} />A few little shortcuts</h4><div><span>A fresh conversation</span><kbd>⌘ / Ctrl K</kbd></div><div><span>Find a conversation</span><kbd>⌘ / Ctrl /</kbd></div><div><span>A new line in chat</span><kbd>Shift Enter</kbd></div><div><span>Close a panel</span><kbd>Esc</kbd></div></div><div className="modal-bottom-note"><ShieldCheck size={14} />Actions are real. Your changes are saved. You’re always in control.</div></Modal>;
}

type TermLine = { kind: "in" | "out" | "err"; text: string; engine?: string };
const DIRECT_VMS = [
  { id: "jslinux", label: "JSLinux · Alpine Root", url: "https://bellard.org/jslinux/vm.html?url=alpine-x86.cfg&mem=192", hint: "Direct root Alpine Linux VM in browser (apk add packages, C compiler, shell)" },
  { id: "v86", label: "v86 · Arch Linux", url: "https://copy.sh/v86/?profile=archlinux", hint: "Full x86 Arch Linux VM running directly in browser (root shell, pacman, networking)" },
] as const;

function TerminalPanel(props: PanelProps) {
  const [mode, setMode] = useState<"sandbox" | "vm">("sandbox");
  const [vmId, setVmId] = useState<(typeof DIRECT_VMS)[number]["id"]>("jslinux");
  const [vmNonce, setVmNonce] = useState(0);
  const [lines, setLines] = useState<TermLine[]>([
    { kind: "out", text: "Aura Virtual Linux Terminal — keyless cloud sandboxes (Wandbox · Paiza.io · Codapi) with persistent workspace sync.\nSupports pip install, npm init/install, git clone, curl, bash pipes/&&, python3, node, sqlite3.\nNeed root apt/apk packages? Switch to the Direct Linux VM tab above." },
  ]);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("/");
  const [engineLabel, setEngineLabel] = useState("Wandbox · Paiza.io · Codapi");
  const [busy, setBusy] = useState(false);
  const past = useRef<string[]>([]);
  const cursor = useRef(-1);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api<{ cwd: string; remote?: { engines?: { label: string; available: boolean }[] } }>("/api/terminal")
      .then((data) => {
        setCwd(data.cwd);
        const ready = data.remote?.engines?.filter((item) => item.available).map((item) => item.label.split(" · ")[0]);
        if (ready?.length) setEngineLabel(ready.join(" · "));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [lines]);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    const line = command.trim();
    if (!line || busy) return;
    setCommand("");
    past.current.unshift(line); cursor.current = -1;
    if (line === "clear") {
      setLines([]);
      return;
    }
    setBusy(true);
    setLines((prev) => [...prev, { kind: "in", text: `${cwd} $ ${line}` }]);
    try {
      const result = await api<{ ok: boolean; output: string; cwd: string; changed: boolean; engine?: string }>("/api/terminal", { method: "POST", body: JSON.stringify({ command: line }) });
      setCwd(result.cwd);
      if (result.output) {
        setLines((prev) => [...prev, { kind: result.ok ? "out" : "err", text: result.output, engine: result.engine }]);
      }
    } catch (error) {
      setLines((prev) => [...prev, { kind: "err", text: (error as Error).message }]);
    } finally { setBusy(false); }
  };
  const history = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(cursor.current + 1, past.current.length - 1);
      if (next >= 0) { cursor.current = next; setCommand(past.current[next]); }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = cursor.current - 1;
      cursor.current = next;
      setCommand(next >= 0 ? past.current[next] : "");
    }
  };
  const activeVm = DIRECT_VMS.find((v) => v.id === vmId) ?? DIRECT_VMS[0];
  return <Modal drawer title="Virtual Linux Terminal" subtitle={mode === "sandbox" ? `Keyless cloud sandbox (${engineLabel}) synced with your workspace.` : activeVm.hint} onClose={props.onClose} className={`terminal-panel ${mode === "vm" ? "vm-wide" : ""}`}>
    <div className="filter-tabs terminal-mode-tabs" role="tablist" aria-label="Terminal mode">
      <button type="button" role="tab" aria-selected={mode === "sandbox"} className={mode === "sandbox" ? "active" : ""} onClick={() => setMode("sandbox")}><Terminal size={13} />Cloud Sandbox</button>
      <button type="button" role="tab" aria-selected={mode === "vm"} className={mode === "vm" ? "active" : ""} onClick={() => setMode("vm")}><Server size={13} />Direct Linux VM</button>
      {mode === "vm" && <div className="vm-switcher">
        {DIRECT_VMS.map((vm) => (
          <button key={vm.id} type="button" className={`vm-choice ${vmId === vm.id ? "selected" : ""}`} onClick={() => setVmId(vm.id)}>{vm.label}</button>
        ))}
        <IconButton label="Reload Linux VM" onClick={() => setVmNonce((n) => n + 1)}><RefreshCw size={14} /></IconButton>
      </div>}
    </div>
    {mode === "sandbox" ? <>
      <div className="terminal-body" ref={logRef} aria-live="polite">{lines.map((line, index) => <pre key={index} className={`term-line ${line.kind}`}>{line.engine && line.engine !== "workspace" ? `[${line.engine}]\n` : ""}{line.text}</pre>)}</div>
      <form className="terminal-input" onSubmit={run}>
        <span className="terminal-prompt">{cwd} $</span>
        <input data-autofocus aria-label="Terminal command" value={command} disabled={busy} onChange={(event) => setCommand(event.target.value)} onKeyDown={history} placeholder="pip install tabulate, npm install ms, uname -a, or help" spellCheck={false} autoComplete="off" />
        <button className="primary-button" disabled={busy || !command.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : "Run"}</button>
      </form>
      <div className="drawer-tip"><Terminal size={15} /><span>Try <strong>pip install tabulate</strong>, <strong>npm install ms</strong>, or <strong>curl -s https://api.github.com/zen</strong>.</span></div>
    </> : <>
      <div className="vm-frame-wrap">
        <iframe key={`${activeVm.id}-${vmNonce}`} className="vm-frame" src={activeVm.url} title={activeVm.label} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" />
      </div>
      <div className="drawer-tip"><Server size={15} /><span>Interactive root Linux VM runs locally inside your browser (no key needed). Use <strong>Cloud Sandbox</strong> to share files with Aura&apos;s AI agent.</span></div>
    </>}
  </Modal>;
}

type BrowserInfo = { availability: { available: boolean; reason?: string }; status: { open: false } | { open: true; url: string; title: string; text: string }; screenshot: string | null };
function BrowserPanel(props: PanelProps) {
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { setInfo(await api<BrowserInfo>("/api/browser")); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const close = async () => {
    setBusy(true);
    try { await api("/api/browser", { method: "POST", body: JSON.stringify({ action: "close" }) }); await load(); props.onNotify("Browser session closed. Cookies and page state were discarded."); }
    catch (err) { props.onNotify((err as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal drawer title="Browser" subtitle="A real Chromium window for your agent. Ephemeral: no logins or saved cookies." onClose={props.onClose} className="browser-panel">
    <div className="drawer-body">
      <div className="browser-panel-bar">
        <span className={`status-dot ${info?.availability.available ? "" : "offline"}`} />
        <span className="browser-panel-state">{!info ? "Checking Chromium…" : info.availability.available ? (info.status.open ? "Session open" : "Chromium ready") : "Chromium unavailable"}</span>
        <IconButton label="Refresh browser status" onClick={() => void load()} disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</IconButton>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {info && !info.availability.available && <div className="privacy-callout"><CircleAlert size={17} /><p>{info.availability.reason} Aura will read public pages with its plain page reader instead, and will tell you so.</p></div>}
      {info?.availability.available && !info.status.open && <div className="browser-empty">
        <span className="step-badge-icon browser-icon"><Compass size={20} /></span>
        <h4>Nothing open yet</h4>
        <p>Ask Aura, for example: <strong>“Open example.com in your browser and take a screenshot.”</strong> It can click links, type into fields, scroll, and go back — every page shows here and in the chat.</p>
      </div>}
      {info?.status.open && <>
        <div className="browser-address"><Globe size={14} /><strong>{info.status.title || "Untitled page"}</strong></div>
        <p className="browser-url">{info.status.url}</p>
        {info.screenshot ? <img className="browser-shot large" src={info.screenshot} alt={info.status.title || "Browser page"} /> : <p className="setting-explainer">No screenshot yet.</p>}
        <div className="browser-panel-actions">
          <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh screenshot</button>
          <button type="button" className="text-button danger-text" onClick={() => void close()} disabled={busy}>Close session</button>
        </div>
      </>}
      <div className="privacy-feature"><div><ShieldCheck size={20} /></div><section><h4>What the browser can and cannot do</h4><p>It loads public http(s) pages only; private network and localhost addresses are blocked. It starts fresh with no accounts, payments, downloads, or saved cookies, and cannot solve captchas or bypass paywalls. It closes after ten idle minutes.</p></section></div>
    </div>
    <div className="drawer-tip"><Sparkles size={16} /><span>Everything the browser does is recorded in the chat as a step with a screenshot.</span></div>
  </Modal>;
}

function LibraryPanel(props: PanelProps) {
  const [tab, setTab] = useState<"memories" | "events" | "bookmarks">("memories");
  const [busy, setBusy] = useState(false);
  const [fact, setFact] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const act = async (method: "POST" | "PATCH" | "DELETE", data: ItemPayload) => {
    setBusy(true);
    try { await props.onItem(method, data); return true; }
    catch (error) { props.onNotify((error as Error).message); return false; }
    finally { setBusy(false); }
  };
  const tabs = [
    { id: "memories" as const, name: `Memories (${props.state.memories.length})`, icon: Brain },
    { id: "events" as const, name: `Events (${props.state.events.length})`, icon: CalendarClock },
    { id: "bookmarks" as const, name: `Bookmarks (${props.state.bookmarks.length})`, icon: Bookmark },
  ];
  return <Modal drawer title="Library" subtitle="What your agent remembers, tracks, and keeps." onClose={props.onClose} className="library-panel">
    <div className="drawer-body">
      <div className="filter-tabs library-tabs">{tabs.map(({ id, name, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={14} />{name}</button>)}</div>
      {tab === "memories" && <>
        <form className="add-task-form" onSubmit={async (e) => { e.preventDefault(); if (fact.trim() && await act("POST", { kind: "memory", title: fact.trim(), fact: fact.trim() })) setFact(""); }}>
          <Brain size={18} /><input value={fact} maxLength={500} onChange={(e) => setFact(e.target.value)} placeholder="Remember: my dog's name is Riku…" aria-label="New memory" />
          <button disabled={busy || !fact.trim()} aria-label="Save memory"><ArrowRight size={17} /></button>
        </form>
        <div className="library-list">{!props.state.memories.length ? <EmptyState icon={<Brain size={27} />} title="A blank slate">Teach Aura lasting facts — “Remember: …” — and they will personalize every chat.</EmptyState> : props.state.memories.map((memory) => <div className="library-row" key={memory.id}>
          <span className="step-badge-icon collection-icon"><Brain size={15} /></span>
          <span className="library-text">{memory.fact}<small>{relativeDate(memory.createdAt)}</small></span>
          <div className="item-actions"><IconButton label="Forget this" onClick={() => props.onConfirm({ title: "Forget this?", detail: `“${memory.fact}” will be permanently forgotten.`, action: async () => { await props.onItem("DELETE", { kind: "memory", id: memory.id }); } })}><Trash2 size={14} /></IconButton></div>
        </div>)}</div>
      </>}
      {tab === "events" && <>
        <form className="add-task-form event-form" onSubmit={async (e) => { e.preventDefault(); if (eventTitle.trim() && eventDate && await act("POST", { kind: "event", title: eventTitle.trim(), date: eventDate })) { setEventTitle(""); setEventDate(""); } }}>
          <CalendarClock size={18} /><input value={eventTitle} maxLength={300} onChange={(e) => setEventTitle(e.target.value)} placeholder="Dentist appointment…" aria-label="New event title" />
          <input type="date" className="task-date-input" value={eventDate} onChange={(e) => setEventDate(e.target.value)} aria-label="Event date" />
          <button disabled={busy || !eventTitle.trim() || !eventDate} aria-label="Save event"><ArrowRight size={17} /></button>
        </form>
        <div className="library-list">{!props.state.events.length ? <EmptyState icon={<CalendarClock size={27} />} title="Nothing on the calendar">Save birthdays, trips, and deadlines — “Add an event: …”. Aura uses them when you plan.</EmptyState> : props.state.events.map((event) => <div className="library-row" key={event.id}>
          <span className="step-badge-icon collection-icon"><CalendarClock size={15} /></span>
          <span className="library-text">{event.title}<small>{event.date}{event.notes ? ` · ${event.notes}` : ""}</small></span>
          <div className="item-actions"><IconButton label="Delete event" onClick={() => props.onConfirm({ title: "Delete this event?", detail: `“${event.title}” will be permanently deleted.`, action: async () => { await props.onItem("DELETE", { kind: "event", id: event.id }); } })}><Trash2 size={14} /></IconButton></div>
        </div>)}</div>
      </>}
      {tab === "bookmarks" && <>
        <form className="add-task-form bookmark-form" onSubmit={async (e) => { e.preventDefault(); if (bookmarkUrl.trim() && await act("POST", { kind: "bookmark", title: bookmarkTitle.trim() || bookmarkUrl.trim(), url: bookmarkUrl.trim() })) { setBookmarkUrl(""); setBookmarkTitle(""); } }}>
          <Bookmark size={18} /><input value={bookmarkUrl} onChange={(e) => setBookmarkUrl(e.target.value)} placeholder="https://…" aria-label="Bookmark URL" />
          <input value={bookmarkTitle} maxLength={300} onChange={(e) => setBookmarkTitle(e.target.value)} placeholder="Title (optional)" aria-label="Bookmark title" />
          <button disabled={busy || !bookmarkUrl.trim()} aria-label="Save bookmark"><ArrowRight size={17} /></button>
        </form>
        <div className="library-list">{!props.state.bookmarks.length ? <EmptyState icon={<Bookmark size={27} />} title="No saved links">Keep pages worth coming back to — “Bookmark https://…”. Aura can search and reopen them.</EmptyState> : props.state.bookmarks.map((bookmark) => <div className="library-row" key={bookmark.id}>
          <span className="step-badge-icon collection-icon"><Bookmark size={15} /></span>
          <span className="library-text"><a href={bookmark.url} target="_blank" rel="noopener noreferrer">{bookmark.title}</a><small>{bookmark.url}</small></span>
          <div className="item-actions"><IconButton label="Delete bookmark" onClick={() => props.onConfirm({ title: "Delete this bookmark?", detail: `“${bookmark.title}” will be permanently deleted.`, action: async () => { await props.onItem("DELETE", { kind: "bookmark", id: bookmark.id }); } })}><Trash2 size={14} /></IconButton></div>
        </div>)}</div>
      </>}
    </div>
    <div className="drawer-tip"><Sparkles size={16} /><span>Or just say, <strong>“Remember that I love hiking”</strong></span></div>
  </Modal>;
}

function SkillsPanel(props: PanelProps) {
  const [query, setQuery] = useState("");
  const groups = SKILL_CATALOG.map((group) => ({ ...group, skills: group.skills.filter((skill) => !query.trim() || `${skill.name} ${skill.blurb} ${skill.example}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter((group) => group.skills.length);
  return <Modal title="Skills" subtitle="Everything your agent can do. Pick one to try it." onClose={props.onClose} className="skills-modal">
    <div className="history-search"><Search size={19} /><input data-autofocus placeholder="Search skills… weather, translate, QR…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />{query && <IconButton label="Clear search" onClick={() => setQuery("")}><X size={15} /></IconButton>}</div>
    <div className="skills-list">{!groups.length ? <EmptyState icon={<Puzzle size={25} />} title="No matching skills">Try “weather”, “translate”, or “QR”.</EmptyState> : groups.map((group) => <section key={group.title} className="skills-group">
      <h3><group.icon size={15} />{group.title}</h3>
      <div className="skills-grid">{group.skills.map((skill) => <button key={skill.name} className="skill-card" onClick={() => props.onPrompt(skill.example)}>
        <span className="step-badge-icon"><skill.icon size={16} /></span>
        <span className="skill-copy"><strong>{skill.name}</strong><small>{skill.blurb}</small><em>Try: “{skill.example}”</em></span>
        <ArrowRight size={15} className="capability-arrow" />
      </button>)}</div>
    </section>)}</div>
    <div className="modal-bottom-note"><ShieldCheck size={14} />Every skill runs for real. Nothing here is a demo.</div>
  </Modal>;
}
