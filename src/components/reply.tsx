"use client";

import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { BookmarkPlus, Check, ChevronDown, ChevronRight, Copy, CornerDownRight, Cpu, Layers, RefreshCw, ThumbsDown, ThumbsUp, Timer, Volume2, VolumeX, Zap } from "lucide-react";
import { AgentStepBlock } from "@/components/agent-step";
import { AuraMark } from "@/components/brand";
import { extractContent, normalizeBlocks } from "@/lib/blocks";
import type { AgentAction, Message, Task } from "@/lib/types";

/** A fenced code block with its language and a copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const first = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(first) ? first.props.className ?? "" : "";
  const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? "text";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* The browser blocked clipboard access; the text can still be selected. */ }
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">{copied ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy</>}</button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const HIGHLIGHT = [rehypeHighlight];
const NO_PLUGINS: never[] = [];
/** While a reply is still arriving, code colouring is skipped: it is the costly part and is applied once at the end. */
const RichText = memo(function RichText({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={live ? NO_PLUGINS : HIGHLIGHT}
      components={{
        a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
      }}
    >{text}</Markdown>
  );
});

function useElapsed(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

const formatDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Suggested next messages. Each one is a real request Aura can carry out. */
function followUps(message: Message, bengali: boolean): string[] {
  const types = new Set(message.actions.map((action) => action.type));
  const list: string[] = [];
  if (types.has("task")) list.push(bengali ? "আমার কাজ দেখাও" : "Show my tasks");
  if (types.has("note")) list.push(bengali ? "আমার নোট দেখাও" : "Show my notes");
  if (types.has("terminal")) list.push("Open terminal");
  if (!message.actions.length && message.meta?.engine) {
    list.push(...(bengali ? ["আরও সংক্ষেপে বলো", "আরও সহজ করে বোঝাও", "একটা উদাহরণ দাও"] : ["Make it shorter", "Explain it more simply", "Give me an example"]));
  }
  return list.slice(0, 3);
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`tool-btn ${active ? "active" : ""}`} title={label} aria-label={label} aria-pressed={active === undefined ? undefined : active} onClick={onClick}>{children}</button>;
}

export type ReplyProps = {
  message: Message;
  streaming: boolean;
  status: string;
  isLast: boolean;
  busy: boolean;
  tasks: Task[];
  speaking: boolean;
  canRegenerate: boolean;
  onOpenAction: (action: AgentAction) => void;
  onToggleTask: (id: string, completed: boolean) => Promise<void>;
  onCopy: (text: string) => void;
  onSpeak: () => void;
  onSaveNote: (text: string) => void;
  onRegenerate: () => void;
  onFeedback: (value: "up" | "down" | null) => void;
  onFollowUp: (text: string) => void;
};

export function AssistantReply(props: ReplyProps) {
  const { message, streaming, status } = props;
  const timeline = normalizeBlocks(message);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const elapsed = useElapsed(streaming);
  const text = message.content || extractContent(timeline);
  const actionCount = timeline.filter((block) => block.type === "action").length;
  const lastBlock = timeline[timeline.length - 1];
  const hasRunning = timeline.some((block) => block.type === "action" && block.action.status === "running");
  const bengali = /[\u0980-\u09ff]/.test(text);
  const chips = props.isLast && !props.busy ? followUps(message, bengali) : [];
  const meta = message.meta;
  let stepNumber = 0;

  return (
    <>
      <div className={`message-avatar ${streaming ? "is-live" : ""}`}><AuraMark size={24} /></div>
      <div className={`assistant-message-content ${streaming ? "is-live" : ""}`}>
        <div className="message-author">
          Aura <span>YOUR AGENT</span>
          {streaming && <span className="live-pill" role="status"><i />{hasRunning ? "Working" : "Live"} · {elapsed}s</span>}
        </div>

        {!streaming && actionCount >= 2 && (
          <button type="button" className="steps-toggle" onClick={() => setStepsOpen((open) => !open)} aria-expanded={stepsOpen}>
            {stepsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Layers size={13} />
            <strong>{actionCount} steps</strong>
            {meta && <span>{formatDuration(meta.durationMs)}</span>}
            <em>{stepsOpen ? "Hide" : "Show"}</em>
          </button>
        )}

        <div className="message-timeline">
          {timeline.map((block, index) => {
            if (block.type === "text") {
              return (
                <div className="markdown" key={`text-${index}`}>
                  <RichText text={block.text} live={streaming && index === timeline.length - 1} />
                  {streaming && index === timeline.length - 1 && !hasRunning && <span className="stream-cursor" />}
                </div>
              );
            }
            stepNumber += 1;
            if (!stepsOpen && !streaming) return null;
            return (
              <div className="step-row" key={block.action.id} data-step={stepNumber}>
                <AgentStepBlock action={block.action} tasks={props.tasks} onToggleTask={props.onToggleTask} onOpen={props.onOpenAction} />
              </div>
            );
          })}
          {streaming && (!timeline.length || lastBlock?.type === "action" || status) && (
            <div className="thinking-indicator"><span /><span /><span /><p>{status || "Thinking it through…"}</p></div>
          )}
        </div>

        {text && !streaming && (
          <div className="reply-toolbar">
            <div className="reply-actions">
              <ToolButton label={copied ? "Copied" : "Copy reply"} onClick={() => { props.onCopy(text); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</ToolButton>
              <ToolButton label={props.speaking ? "Stop reading" : "Read aloud"} active={props.speaking} onClick={props.onSpeak}>{props.speaking ? <VolumeX size={14} /> : <Volume2 size={14} />}</ToolButton>
              <ToolButton label="Save reply as a note" onClick={() => props.onSaveNote(text)}><BookmarkPlus size={14} /></ToolButton>
              {props.canRegenerate && <ToolButton label="Regenerate reply" onClick={props.onRegenerate}><RefreshCw size={14} /></ToolButton>}
              <i className="reply-divider" />
              <ToolButton label="Good reply" active={message.feedback === "up"} onClick={() => props.onFeedback(message.feedback === "up" ? null : "up")}><ThumbsUp size={14} /></ToolButton>
              <ToolButton label="Needs work" active={message.feedback === "down"} onClick={() => props.onFeedback(message.feedback === "down" ? null : "down")}><ThumbsDown size={14} /></ToolButton>
            </div>
            <div className="reply-meta">
              <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              {meta && (
                <>
                  <span className="meta-dot" aria-hidden="true">·</span>
                  {meta.engine
                    ? <span className="meta-item" title={meta.model ?? undefined}><Cpu size={11} />{meta.engine}</span>
                    : <span className="meta-item instant" title="Done by Aura's built-in actions. No AI request was sent."><Zap size={11} />Instant</span>}
                  {meta.steps > 0 && (
                    <>
                      <span className="meta-dot" aria-hidden="true">·</span>
                      <span className="meta-item"><Layers size={11} />{meta.steps} {meta.steps === 1 ? "step" : "steps"}</span>
                    </>
                  )}
                  <span className="meta-dot" aria-hidden="true">·</span>
                  <span className="meta-item"><Timer size={11} />{formatDuration(meta.durationMs)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {chips.length > 0 && (
          <div className="follow-ups" aria-label="Suggested next messages">
            {chips.map((chip) => <button type="button" key={chip} className="follow-chip" onClick={() => props.onFollowUp(chip)}><CornerDownRight size={12} />{chip}</button>)}
          </div>
        )}
      </div>
    </>
  );
}
