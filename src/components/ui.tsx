"use client";

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import type { Conversation } from "@/lib/types";

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? "is-on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} disabled={disabled}><span /></button>;
}

export function Modal({ title, children, onClose, className = "", drawer = false, subtitle }: { title: string; children: ReactNode; onClose: () => void; className?: string; drawer?: boolean; subtitle?: string }) {
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const target = ref.current?.querySelector<HTMLElement>("[data-autofocus]") || ref.current?.querySelector<HTMLElement>("button:not([disabled]), input, textarea, select") || ref.current;
      target?.focus();
    });
    const listener = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const targets = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]');
        if (!targets?.length) return;
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", listener);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = overflow; document.removeEventListener("keydown", listener); previous?.focus(); };
  }, [onClose]);
  return <div className={`modal-overlay ${drawer ? "drawer-overlay" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} className={`modal ${drawer ? "drawer" : ""} ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header className="modal-header"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="Close panel" onClick={onClose}><X size={19} /></IconButton></header>
      {children}
    </section>
  </div>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}

export function ChatMenu({ chat, onChange, onRename, onDelete }: {
  chat: Conversation;
  onChange: (id: string, change: Partial<Conversation>) => void;
  onRename: (chat: Conversation) => void;
  onDelete: (chat: Conversation) => void;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setPosition(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setPosition(null); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [position]);
  const act = (fn: () => void) => { setPosition(null); fn(); };
  return <>
    <button ref={buttonRef} className={`icon-button chat-menu-trigger ${position ? "is-open" : ""}`} aria-label={`Options for ${chat.title}`} aria-expanded={!!position} onClick={(event) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition(position ? null : { top: Math.min(rect.bottom + 5, window.innerHeight - 192), left: Math.min(window.innerWidth - 190, Math.max(8, rect.right - 180)) });
    }}><MoreHorizontal size={17} /></button>
    {position && createPortal(<div ref={menuRef} className="chat-menu" style={position} role="menu">
      <button role="menuitem" onClick={() => act(() => onChange(chat.id, { pinned: !chat.pinned }))}>{chat.pinned ? <PinOff size={15} /> : <Pin size={15} />}{chat.pinned ? "Unpin chat" : "Pin chat"}</button>
      <button role="menuitem" onClick={() => act(() => onRename(chat))}><Pencil size={15} />Rename</button>
      <button role="menuitem" onClick={() => act(() => onChange(chat.id, { archived: !chat.archived }))}>{chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{chat.archived ? "Restore chat" : "Archive chat"}</button>
      <div className="menu-separator" />
      <button role="menuitem" className="danger-text" onClick={() => act(() => onDelete(chat))}><Trash2 size={15} />Delete chat</button>
    </div>, document.body)}
  </>;
}
