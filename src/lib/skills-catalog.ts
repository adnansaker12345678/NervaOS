"use client";

import {
  Bitcoin, BookMarked, BookOpen, Bookmark, Bot, Brain, Calculator, CalendarClock, Clapperboard, Clock3, CloudSun, Code, Coins,
  Compass, FileText, Globe, Image as ImageIcon, Languages, ListChecks, ListTodo, Newspaper, PartyPopper, PenLine, QrCode,
  Ruler, SlidersHorizontal, Sparkles, Terminal, Type, Users, type LucideIcon,
} from "lucide-react";
import { SPECIALISTS } from "@/lib/specialists";

export type SkillEntry = { name: string; blurb: string; example: string; icon: LucideIcon };
export type SkillGroup = { title: string; icon: LucideIcon; skills: SkillEntry[] };

const TEAM_ICONS: Record<string, LucideIcon> = {
  coder: Code,
  researcher: Globe,
  designer: ImageIcon,
  video_creator: Clapperboard,
  writer: PenLine,
};

/** The honest, complete catalog of what the agent can do. Every entry maps to a real tool. */
export const SKILL_CATALOG: SkillGroup[] = [
  {
    title: "Live world",
    icon: Globe,
    skills: [
      { name: "Weather", blurb: "Current conditions plus a 3-day forecast for any city.", example: "What's the weather in Dhaka?", icon: CloudSun },
      { name: "Currency", blurb: "Convert money at today's real rate.", example: "Convert 100 USD to BDT", icon: Coins },
      { name: "Crypto", blurb: "Live coin prices.", example: "Price of bitcoin and ethereum", icon: Bitcoin },
      { name: "Translate", blurb: "Translate into 20+ languages.", example: "Translate good morning to Bengali", icon: Languages },
      { name: "Define", blurb: "Dictionary meanings with examples.", example: "Define serendipity", icon: BookOpen },
      { name: "Wikipedia", blurb: "Summaries of people, places, and topics.", example: "Tell me about the Sundarbans", icon: BookMarked },
      { name: "Tech news", blurb: "Fresh headlines by keyword.", example: "Latest AI news", icon: Newspaper },
      { name: "Holidays", blurb: "Public holidays for any country.", example: "Holidays in Bangladesh 2026", icon: PartyPopper },
    ],
  },
  {
    title: "Make & compute",
    icon: Sparkles,
    skills: [
      { name: "Calculator", blurb: "Exact arithmetic, never mental math.", example: "Calculate (12 + 8) * 3.5", icon: Calculator },
      { name: "Units", blurb: "Length, weight, temperature, speed, data.", example: "Convert 5 km to miles", icon: Ruler },
      { name: "Text tools", blurb: "Count, case, slug, base64, JSON, UUIDs, passwords.", example: "Make me a 20-character password", icon: Type },
      { name: "JavaScript", blurb: "Run small code safely and see the result.", example: "Run JS to list the first 10 Fibonacci numbers", icon: Code },
      { name: "QR codes", blurb: "Turn text or links into scannable images.", example: "Make a QR code for https://example.com", icon: QrCode },
      { name: "Images", blurb: "Generate AI pictures from words.", example: "Generate an image of a calm lake at dawn", icon: ImageIcon },
      { name: "Clock", blurb: "The time anywhere on Earth.", example: "What time is it in Tokyo?", icon: Clock3 },
    ],
  },
  {
    title: "Remember & organize",
    icon: Brain,
    skills: [
      { name: "Memory", blurb: "Facts that personalize every chat.", example: "Remember that my dog's name is Riku", icon: Brain },
      { name: "Events", blurb: "Birthdays, trips, deadlines.", example: "Add an event: Dentist on 2026-12-24", icon: CalendarClock },
      { name: "Bookmarks", blurb: "Links worth keeping.", example: "Bookmark https://example.com as Example", icon: Bookmark },
      { name: "Tasks", blurb: "To-dos with due dates and priorities.", example: "Create tasks: Draft proposal, Review designs", icon: ListTodo },
      { name: "Notes", blurb: "Ideas kept forever.", example: "Save a note: my next big idea", icon: FileText },
      { name: "Preferences", blurb: "Theme, language, focus mode, and more.", example: "Switch to dark mode", icon: SlidersHorizontal },
      { name: "Plan first", blurb: "A live checklist plan before multi-step work — watch it tick.", example: "always plan", icon: ListChecks },
    ],
  },
  {
    title: "Browse & build",
    icon: Compass,
    skills: [
      { name: "Web search", blurb: "Search and actually read the best pages.", example: "Who won the 2022 FIFA World Cup final?", icon: Globe },
      { name: "Browser", blurb: "A real Chromium the agent drives.", example: "Open example.com in your browser", icon: Compass },
      { name: "Terminal", blurb: "Keyless cloud Linux shell with pip/npm installs, git clone, & Direct Linux VM.", example: "Use the terminal to run uname -a && pip install tabulate && python3 -c \"from tabulate import tabulate; print(tabulate([['Aura', 'Live']]))\"", icon: Terminal },
    ],
  },
  {
    title: "Agent team",
    icon: Users,
    skills: [
      ...SPECIALISTS.map((member) => ({
        name: member.label,
        blurb: `${member.tagline}. Hired for focused jobs.`,
        example: member.example,
        icon: TEAM_ICONS[member.id] ?? Bot,
      })),
      { name: "Meet the team", blurb: "See the full roster in chat.", example: "Who is on your team?", icon: Users },
    ],
  },
];
