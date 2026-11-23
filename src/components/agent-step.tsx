"use client";

import { useState } from "react";
import { ArrowUpRight, Bitcoin, BookMarked, Bot, BookOpen, Bookmark as BookmarkIcon, Brain, Calculator, CalendarClock, CalendarDays, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleAlert, Clock3, CloudSun, Code, Coins, Compass, ExternalLink, FileText, Flag, Globe, Image as ImageIcon, Languages, Layers, ListChecks, LoaderCircle, Minus, Newspaper, PartyPopper, QrCode, Ruler, X, Search, SlidersHorizontal, Terminal, Type } from "lucide-react";
import { formatDue } from "@/lib/client";
import type { AgentAction, PlanStep, Task, TaskSummary } from "@/lib/types";

/** Due date and priority chips, shared by the chat task card and the Tasks panel. */
export function TaskBadges({ task }: { task: Pick<Task, "due" | "priority" | "completed"> }) {
  const due = formatDue(task.due);
  if (!due && task.priority === "normal") return null;
  return (
    <span className="task-badges">
      {due && <span className={`due-chip ${due.overdue && !task.completed ? "overdue" : ""}`}><CalendarDays size={11} />{due.label}</span>}
      {task.priority !== "normal" && <span className={`prio-chip ${task.priority}`}><Flag size={11} />{task.priority === "high" ? "High" : "Low"}</span>}
    </span>
  );
}

/** A live checklist inside the reply. Ticking a row updates the real task. */
function TaskCard({ action, live, onToggle, onOpen }: { action: AgentAction; live: Task[]; onToggle?: (id: string, completed: boolean) => Promise<void>; onOpen: (action: AgentAction) => void }) {
  const snapshot = (action.data?.tasks as TaskSummary[]) ?? [];
  const rows = snapshot.map((item) => ({ item: live.find((task) => task.id === item.id) ?? item, exists: live.some((task) => task.id === item.id) }));
  const done = rows.filter((row) => row.item.completed).length;
  const complete = rows.length > 0 && done === rows.length;
  return (
    <div className={`step-block task-step ${complete ? "is-complete" : ""}`}>
      <div className="task-step-head">
        <span className="step-badge-icon"><CheckCheck size={15} /></span>
        <span className="step-copy"><strong>{action.title}</strong><small>{done} of {rows.length} done</small></span>
        <span className="task-progress" aria-hidden="true"><i style={{ width: `${rows.length ? (done / rows.length) * 100 : 0}%` }} /></span>
        <button type="button" className="step-open-btn" onClick={() => onOpen(action)} aria-label="Open My tasks" title="Open My tasks"><ArrowUpRight size={14} /></button>
      </div>
      <ul className="task-step-list">
        {rows.map(({ item, exists }) => (
          <li key={item.id} className={item.completed ? "is-done" : ""}>
            <button type="button" className="task-tick" role="checkbox" aria-checked={item.completed} disabled={!exists || !onToggle}
              aria-label={item.completed ? `Reopen ${item.title}` : `Complete ${item.title}`} title={exists ? undefined : "This task is no longer in your list"}
              onClick={() => void onToggle?.(item.id, !item.completed)}>{item.completed && <Check size={12} />}</button>
            <span className="task-step-title">{item.title}</span>
            <TaskBadges task={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentStepInner({ action, onOpen, tasks = [], onToggleTask }: { action: AgentAction; onOpen: (action: AgentAction) => void; tasks?: Task[]; onToggleTask?: (id: string, completed: boolean) => Promise<void> }) {
  const output = typeof action.data?.output === "string" ? action.data.output : "";
  const isRunning = action.status === "running";
  const isError = action.status === "error" || action.data?.ok === false;
  const isTerminal = action.type === "terminal";
  const isWeb = action.type === "web";
  const isSkill = action.type === "calc" || action.type === "time" || action.type === "workspace" || action.type === "skill";
  const isCollection = action.type === "memory" || action.type === "event" || action.type === "bookmark";
  const skillName = typeof action.data?.skill === "string" ? action.data.skill : "";
  const image = typeof action.data?.image === "string" ? action.data.image : "";
  const [expanded, setExpanded] = useState(isTerminal || action.type === "calc");

  const statusBadge = isRunning
    ? <span className="step-status running"><LoaderCircle size={12} className="spin" />Running</span>
    : isError
      ? <span className="step-status error"><CircleAlert size={12} />Failed</span>
      : <span className="step-status done"><Check size={12} />Done</span>;

  if (action.type === "search") {
    const results = (action.data?.results as { title: string; url: string; snippet?: string; site?: string; date?: string; kind?: string }[] | undefined) ?? [];
    const freshCount = results.filter((item) => item.kind === "news").length;
    return (
      <div className={`step-block search-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="web-step-head">
          <button type="button" className="web-step-toggle" onClick={() => results.length && setExpanded((open) => !open)} aria-expanded={results.length ? expanded : undefined}>
            <span className="step-badge-icon search-icon"><Search size={15} /></span>
            <span className="step-copy"><strong>{action.title}</strong>{action.detail && <small>{action.detail}</small>}</span>
            {freshCount > 0 && <span className="fresh-chip"><Newspaper size={11} />{freshCount} fresh</span>}
          </button>
          <div className="terminal-step-meta">
            {statusBadge}
            {results.length > 0 && <button type="button" className="step-open-btn" onClick={() => setExpanded((open) => !open)} aria-label={expanded ? "Hide sources" : "Show sources"}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
          </div>
        </div>
        {expanded && (results.length > 0 || output) && <div className="search-body">
          {results.length > 0 && <ol className="search-results">{results.map((result, index) => <li key={result.url}>
            <a href={result.url} target="_blank" rel="noopener noreferrer"><span className="search-rank">{index + 1}</span><span className="search-copy"><strong>{result.title}</strong><small>{result.site ?? result.url}{result.date ? ` · ${result.date}` : ""}</small>{result.snippet && <em>{result.snippet}</em>}</span><ExternalLink size={12} /></a>
          </li>)}</ol>}
          {output && <pre className="search-note">{output}</pre>}
        </div>}
      </div>
    );
  }

  if (isCollection) {
    const icon = action.type === "memory" ? <Brain size={15} /> : action.type === "event" ? <CalendarClock size={15} /> : <BookmarkIcon size={15} />;
    return (
      <div className={`step-block skill-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="web-step-head">
          <button type="button" className="web-step-toggle" onClick={() => onOpen(action)}>
            <span className="step-badge-icon collection-icon">{isRunning ? <LoaderCircle size={15} className="spin" /> : icon}</span>
            <span className="step-copy"><strong>{action.title}</strong>{action.detail && <small>{action.detail}</small>}</span>
          </button>
          <div className="terminal-step-meta">
            {statusBadge}
            <button type="button" className="step-open-btn" onClick={() => onOpen(action)} aria-label="Open library" title="Open library"><ArrowUpRight size={14} /></button>
          </div>
        </div>
        {expanded && output && !isError && <pre className="web-step-output">{output}</pre>}
        {output && isError && <pre className="web-step-output is-error">{output}</pre>}
      </div>
    );
  }

  if (action.type === "browser") {
    const screenshot = typeof action.data?.screenshot === "string" ? action.data.screenshot : "";
    const target = typeof action.data?.url === "string" ? action.data.url : "";
    return (
      <div className={`step-block browser-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="web-step-head">
          <button type="button" className="web-step-toggle" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
            <span className="step-badge-icon browser-icon"><Compass size={15} /></span>
            <span className="step-copy"><strong>{action.title}</strong>{action.detail && <small>{action.detail}</small>}</span>
          </button>
          <div className="terminal-step-meta">
            {statusBadge}
            <button type="button" className="step-open-btn" onClick={() => onOpen(action)} title="Open the Browser panel" aria-label="Open the Browser panel"><ArrowUpRight size={14} /></button>
            {(output || screenshot) && <button type="button" className="step-open-btn" onClick={() => setExpanded((open) => !open)} aria-label={expanded ? "Hide page details" : "Show page details"}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
          </div>
        </div>
        {expanded && (screenshot || output) && <div className="browser-body">
          {screenshot && <img className="browser-shot" src={screenshot} alt={action.title} loading="lazy" />}
          {output && <pre className="browser-text">{output}</pre>}
          {target && <a className="browser-link" href={target} target="_blank" rel="noopener noreferrer">Open this page in a new tab <Globe size={12} /></a>}
        </div>}
      </div>
    );
  }

  if (action.type === "task" && !isRunning && !isError && Array.isArray(action.data?.tasks) && action.data.tasks.length > 0) {
    return <TaskCard action={action} live={tasks} onToggle={onToggleTask} onOpen={onOpen} />;
  }

  if (action.type === "plan" && Array.isArray(action.data?.plan) && (action.data.plan as PlanStep[]).length) {
    const steps = action.data.plan as PlanStep[];
    const doneCount = steps.filter((step) => step.status === "done").length;
    const isComplete = steps.length > 0 && doneCount === steps.length;
    const isActive = steps.some((step) => step.status === "active");
    return (
      <div className={`step-block plan-step ${isActive ? "is-running" : ""} ${isComplete ? "is-complete" : ""}`}>
        <div className="plan-head">
          <span className="step-badge-icon plan-icon"><ListChecks size={15} /></span>
          <span className="step-copy"><strong>{action.title}</strong><small>{action.detail}</small></span>
          <span className="task-progress" aria-hidden="true"><i style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }} /></span>
        </div>
        <ol className="plan-list">
          {steps.map((step, index) => (
            <li key={step.id} className={`plan-item ${step.status}`}>
              <span className="plan-num">{index + 1}</span>
              <span className="plan-ico" aria-hidden="true">
                {step.status === "done" ? <Check size={13} />
                  : step.status === "active" ? <LoaderCircle size={13} className="spin" />
                    : step.status === "skipped" ? <Minus size={13} />
                      : step.status === "failed" ? <X size={13} /> : <Circle size={11} />}
              </span>
              <span className="plan-title">{step.title}{step.note && <em> — {step.note}</em>}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (isTerminal) {
    return (
      <div className={`step-block terminal-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="terminal-step-head">
          <button type="button" className="terminal-step-toggle" onClick={() => setExpanded((prev) => !prev)} aria-expanded={expanded}>
            <span className="step-badge-icon terminal-icon"><Terminal size={14} /></span>
            <code className="terminal-step-cmd">{action.title}</code>
            {action.detail && <span className="terminal-step-cwd">{action.detail}</span>}
          </button>
          <div className="terminal-step-meta">
            {statusBadge}
            <button type="button" className="step-open-btn" onClick={() => onOpen(action)} title="Open Terminal panel" aria-label="Open Terminal panel">
              <ArrowUpRight size={14} />
            </button>
            {output && (
              <button type="button" className="step-open-btn" onClick={() => setExpanded((prev) => !prev)} title={expanded ? "Hide output" : "Show output"} aria-label={expanded ? "Hide terminal output" : "Show terminal output"}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
          </div>
        </div>
        {expanded && output && <pre className={`terminal-step-output ${isError ? "is-error" : ""}`}>{output}</pre>}
      </div>
    );
  }

  if (isWeb) {
    return (
      <div className={`step-block web-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="web-step-head">
          <button type="button" className="web-step-toggle" onClick={() => output && setExpanded((prev) => !prev)} aria-expanded={output ? expanded : undefined}>
            <span className="step-badge-icon"><Globe size={15} /></span>
            <span className="step-copy">
              <strong>{action.title}</strong>
              {action.detail && <small>{action.detail}</small>}
            </span>
          </button>
          <div className="terminal-step-meta">
            {statusBadge}
            {output && (
              <button type="button" className="step-open-btn" onClick={() => setExpanded((prev) => !prev)} aria-label={expanded ? "Collapse excerpt" : "Expand excerpt"}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            )}
          </div>
        </div>
        {expanded && output && <pre className="web-step-output">{output}</pre>}
      </div>
    );
  }

  if (isSkill) {
    const icons: Record<string, React.ReactNode> = {
      weather: <CloudSun size={15} />, currency: <Coins size={15} />, crypto: <Bitcoin size={15} />, translate: <Languages size={15} />,
      define: <BookOpen size={15} />, wiki: <BookMarked size={15} />, news: <Newspaper size={15} />, holidays: <PartyPopper size={15} />,
      unit: <Ruler size={15} />, text: <Type size={15} />, code: <Code size={15} />, qr: <QrCode size={15} />, image: <ImageIcon size={15} />, team: <Bot size={15} />,
    };
    const icon = action.type === "calc" ? <Calculator size={15} /> : action.type === "time" ? <Clock3 size={15} /> : icons[skillName] ?? <Layers size={15} />;
    const clickable = Boolean(action.data?.panel);
    return (
      <div className={`step-block skill-step ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`}>
        <div className="web-step-head">
          {clickable ? (
            <button type="button" className="web-step-toggle" onClick={() => onOpen(action)}>
              <span className="step-badge-icon">{icon}</span>
              <span className="step-copy">
                <strong>{action.title}</strong>
                {action.detail && <small>{action.detail}</small>}
              </span>
            </button>
          ) : (
            <div className="web-step-toggle static">
              <span className="step-badge-icon">{icon}</span>
              <span className="step-copy">
                <strong>{action.title}</strong>
                {action.detail && <small>{action.detail}</small>}
              </span>
            </div>
          )}
          <div className="terminal-step-meta">
            {statusBadge}
            {clickable && <button type="button" className="step-open-btn" onClick={() => onOpen(action)} aria-label={`Open ${String(action.data?.panel)}`}><ArrowUpRight size={14} /></button>}
          </div>
        </div>
        {image && <div className="skill-image-wrap"><img className="skill-image" src={image} alt={action.title} loading="lazy" /></div>}
        {output && !isError && <div className="skill-output-bar"><button type="button" onClick={() => setExpanded((open) => !open)}>{expanded ? "Hide details" : "Show details"}</button></div>}
        {expanded && output && !isError && <pre className="web-step-output">{output}</pre>}
        {output && isError && <pre className="web-step-output is-error">{output}</pre>}
      </div>
    );
  }

  return (
    <div className="step-block">
      <button type="button" className={`action-card ${isRunning ? "is-running" : ""} ${isError ? "is-error" : ""}`} onClick={() => onOpen(action)}>
        <span className="action-icon">
          {isRunning ? <LoaderCircle size={16} className="spin" /> : action.type === "task" ? <CheckCheck size={17} /> : action.type === "note" ? <FileText size={17} /> : action.type === "settings" ? <SlidersHorizontal size={17} /> : <Check size={17} />}
        </span>
        <span>
          <strong>{action.title}</strong>
          {action.detail && <small>{action.detail}</small>}
        </span>
        <ArrowUpRight size={15} />
      </button>
    </div>
  );
}

/** Steps done by a hired specialist get a small "via" tag and an indented rail. */
export function AgentStepBlock(props: { action: AgentAction; onOpen: (action: AgentAction) => void; tasks?: Task[]; onToggleTask?: (id: string, completed: boolean) => Promise<void> }) {
  const via = typeof props.action.data?.subagentLabel === "string" ? props.action.data.subagentLabel : "";
  if (!via) return <AgentStepInner {...props} />;
  return (
    <div className="subagent-wrap">
      <span className="via-tag"><Bot size={11} />via {via}</span>
      <AgentStepInner {...props} />
    </div>
  );
}
