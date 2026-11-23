# Aura

A chat-first personal workspace built with Next.js App Router, TypeScript, PostgreSQL, and Drizzle. There is no marketing page, sample history, fake assistant, or mock data.

## What works

- Persistent browser-private workspaces, conversations, attachments, tasks, notes, and preferences.
- Streaming chat from a backend AI engine; the browser never holds or asks for an API key.
- Instant built-in workspace commands, executed in PostgreSQL: create and complete tasks, save notes, show lists, rename/pin/archive chats, change appearance, export data, and toggle preferences.
- Full-message history search, conversation pinning, renaming, archiving, deletion, and JSON workspace export.
- Agent action receipts that show actual successful database changes.
- Light, dark, and system themes, focus mode, compact conversations, personalization controls, and optional reply sounds.
- Image and text/code attachments (three files per message, 2 MB per file). Text and code are read by the engine; image understanding requires a vision-capable backend engine. PDFs are not supported.
- Browser-native speech recognition where supported, subject to browser microphone permissions.
- Responsive navigation and keyboard-accessible dialogs.

## AI engine (backend only)

There is no API-key field in the app. All model calls happen on the server through an OpenAI-compatible chat-completions adapter in `src/lib/ai.ts`.

Provider priority:

1. `AURA_AI_BASE_URL` — any self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, an internal gateway). Optional: `AURA_AI_MODEL`, `AURA_AI_KEY`, `AURA_AI_LABEL`, `AURA_AI_VISION`.
2. `OPENAI_API_KEY` — optional server-side OpenAI connection (`OPENAI_MODEL` defaults to `gpt-4.1-mini`).
3. `GROQ_API_KEY` or `OPENROUTER_API_KEY` — optional server-side alternatives.
4. Verified keyless pool (no account, no key), ordered fastest-first: OVH AI Endpoints `gpt-oss-120b`, `Mistral-Small-3.2`, `Qwen3.6-27B`, `Llama 3.3 70B`, `gpt-oss-20b`, `Qwen3.8-27B`, and Pollinations as a slow last resort. Each was measured from the backend for first-token time, writing speed, and two-step tool calling.

### Why replies are fast

- **Rotation.** OVH limits each model separately (about two requests a minute). Aura tracks every engine's window and moves to the next ready one without waiting.
- **Racing.** Free engines start anywhere between 0.4 and 10 seconds. If the first has not started within 2.5 seconds, a second is started alongside it (a third after 6 seconds); the first to produce output wins and the others are cancelled.
- **Small requests.** Only the tools a message needs are sent (a core set plus groups triggered by the conversation), which cuts prompt size by roughly two thirds.
- **Fewer turns.** Everyday commands run with no AI at all. Plain actions ("add an event…") and self-answering tools (calculator, currency, translation…) finish in one AI turn instead of two, but only when the user asked for exactly that.
- **Smooth drawing.** The server sends text in ~40 ms slices and the browser draws about twenty times a second; code colouring is applied once the reply is complete.

Measured on this backend: plain answers start in 1.3–2.6 s and finish in 2–6 s; single actions take about 1.4 s; instant commands 10–500 ms. When ten AI requests are sent back-to-back, the free pool (about twelve AI turns a minute) can run dry; Aura then waits for the next fast engine and shows the countdown.

Workspace actions (tasks, notes, preferences, pinning, renaming, archiving, exports) are executed by a deterministic server-side action layer and are instant, independent of model availability or cooldowns.

The keyless engines are best-effort third-party free services with no uptime guarantee, and their start times vary with load. For production, configure a self-hosted or provider-backed engine with the server environment variables above. No credential is ever stored in the database or sent to the browser.

Limitations are stated in the product rather than simulated: no web browsing, no email or calendar access, no scheduled reminders, and no image understanding on a text-only engine.

## What the agent can do

Aura's agent runs a real tool loop (up to 6 steps per request). It decides when to use a tool, sees the verified result, and then answers.

- **Workspace actions:** list tasks and notes, add tasks, complete tasks, save notes, change preferences, rename the current conversation, open panels.
- **Terminal:** a sandboxed, private shell (`help`, `ls`, `cd`, `mkdir`, `cat`, `head`, `wc`, `write`, `append`, `touch`, `grep`, `rm`, `echo`, `date`, `calc`). It works only on this workspace's own files stored in PostgreSQL. It never starts a process or touches the server. Pipes, redirects, chaining, and `$()` are disabled. `rm` runs only when the user explicitly asks to delete. A Terminal panel gives direct access.
- **Calculator:** exact arithmetic with a small parser (no `eval`).
- **Time:** current time in any IANA time zone.
- **Web reading:** reads public `http`/`https` pages. Private, loopback, link-local, and metadata addresses are refused, every redirect is re-checked, responses are capped at 400 KB, and only text content is read.
- **Live world (all keyless):** weather + 3-day forecast for any city (Open-Meteo), currency conversion (ExchangeRate-API with Frankfurter fallback), crypto prices (CoinGecko), translation into 20+ languages, dictionary definitions, Wikipedia summaries, tech headlines (Hacker News), and public holidays by country.
- **Make & compute:** unit conversion, text tools (count, case, slug, base64, URL, JSON, UUID, passwords, SHA-256, reading time), sandboxed JavaScript execution (2s timeout, no network/files/imports), QR code images saved to workspace files, and AI image generation saved with a reference file.
- **Memory, events, bookmarks:** lasting facts that personalize chats, dated events, and saved links — all in the Library panel and the JSON export.

Common requests (“What's the weather in Dhaka?”, “Translate … to Bengali”, “Define …”, “Convert 100 USD to BDT”, “Make a QR code for …”, “Remember: …”) run instantly with no AI wait. Everything else goes through the tool loop. The Skills panel lists the full catalog with try-it examples.

Not included, on purpose: a real server shell (any visitor could otherwise run commands on the host), logging into websites, sending email, stock trading data, push reminders/notifications. Known limitation: DNS-rebinding protection is best-effort.

## Agent team (subagents)

The main agent can hire specialists with `hire_agent`, and you can meet them with “Who is on your team?” or in the Skills panel:

- **Coder** — writes JavaScript and verifies it by running it; saves useful code to files. Only JavaScript executes (via `js_run`); the terminal only stores files.
- **Researcher** — searches the live web, reads full pages, and reports with cited URLs.
- **Designer** — generates AI images and QR codes; pictures appear in the chat.
- **Video creator** — writes a script, generates scene images, and saves a playable `player.html` slideshow under `/video/<slug>/`. There is no true video-rendering API without a key, so it says plainly that the deliverable is a slideshow, not an MP4.
- **Writer** — drafts documents and saves them to `/docs/*.md` files (not notes).

Each hire runs its own focused loop (3–5 steps) with only its own tools — subagents cannot hire further agents. Their steps appear inline tagged “via Coder” etc., and the hire result carries a verified step list so the final summary can only quote what really happened. A specialist that uses no tools is sent back to work once instead of being allowed to bluff; a tool that fails twice is dropped for that request.

## Planning first

Before any job that needs multiple steps, the agent drafts a plan with `make_plan` and renders it as a live checklist in the chat. Each step has a stable id: steps can never be silently deleted or reordered, only closed — `done`, `skipped`, or `failed` with a short honest reason (`update_plan`). That keeps scope changes visible instead of quietly rewritten.

- **Modes:** `auto` (plan only when it helps — default), `always`, `off`. Change them in **Settings → Plan before acting**, in chat ("always plan", "never plan", "set planning to auto"), per-message with the composer's **Plan first** chip, or by starting a message with "Plan first:".
- **Guarantees:** the loop's step budget grows with the plan; if the model tries to answer with steps still open it gets one nudge to close them; an unclosable step is marked failed/skipped, never left dangling. A second `make_plan` is refused until one step closes, and a turn that only re-plans is ended gracefully — small models cannot spin in planning loops. Specialists cannot manage the plan — the main agent owns it. Several finished steps can be closed in one `update_plan` (the `updates` array) to save turns on slow engines.
- **Replanning:** calling `make_plan` again visibly replaces the checklist when reality changes (a tool failing, new evidence).
- The plan lives inside the reply's timeline (persisted with the message), so progress and final state survive reload.


Tasks have a title, an optional due date, and a priority. The agent can add, complete, reopen, rename, reschedule, and delete them (`create_tasks`, `update_task`, `complete_task`, `delete_task`). It finds a task by its title, so internal ids never appear in replies.

- Due dates are stored as local values (`2026-11-16` or `2026-11-16T17:00`) in the user's own time zone, which the browser sends with each message.
- Plain requests such as "Set a task: …", "Create tasks: a, b", or "টাস্ক সেট করো: …" run instantly without an AI request. "today", "tomorrow", "আজ", "কাল", and clock times such as "5pm" set the due date.
- A due date only appears in the task list. There are no alerts or notifications.

## Replies

- Each reply is a timeline: text, then each action with its result, in the order they happened. Steps are numbered and can be collapsed.
- Tasks added in a reply appear as a checklist. Ticking a row updates the real task.
- Code blocks show their language, are syntax-highlighted, and have a copy button.
- Under a reply: copy, read aloud (browser speech synthesis), save as a note, thumbs up/down (stored with the message), and regenerate.
- Regenerate is offered only for the latest reply, and only when that reply changed nothing. Re-running a reply that added tasks or wrote files would repeat those changes.
- Each reply shows how it was produced: the engine used, or "Instant · no AI" for built-in actions, plus step count and duration.
- Suggested next messages are real requests. Type `/` in the composer for a command list.

## Web search and reading (freshness-first, Google-style)

`web_search` is a real multi-source search engine, built so every time-sensitive answer is dated and current:

1. **Optional real Google** — set `SERPER_API_KEY` on the server (serper.dev, free tier ~25k queries) and searches go through Google's SERP + Google News with true day/week/month/year date filters. `BRAVE_API_KEY` (2k free queries/month, freshness filters) and `TAVILY_API_KEY` (news topic with day windows) work the same way. No key is ever entered in the browser; the UI notes stay honest about which path ran.
2. **Real Google, keyless:** the agent opens `google.com/search` itself in its own headless Chromium (with day/week/month/year `tbs=qdr:` filters and relative-date parsing like "3 hours ago" → a real date). Google sometimes challenges shared server IPs — the source backs off for 30 minutes on a challenge, paces to one search per 20 seconds, and the chain continues without it.
3. **Keyless and fresh by default:** for anything time-sensitive, dated headlines come FIRST from Google News RSS and Bing News RSS (no key — real feeds updated to the minute, every item carries its publish date), then general web results from FreeSerp Global (3.1B pages, `fresh=1` + publish-date window) and DuckDuckGo with genuine date filters (`df=d/w/m/y`), then Bing and Wikipedia as backups.
4. **Freshness is a first-class parameter:** `freshness="auto" | "any" | "day" | "week" | "month" | "year"` — `auto` reads words like "today", "latest", "breaking", "news", "আজ", "সর্বশেষ" and picks day/week itself. The agent is instructed to set `day` for today/breaking/results questions and to say which date its answer reflects.
5. **Full articles, not snippets:** after ranking, Aura reads the top pages (up to four, ~4,500 chars each) — Google News redirect wrappers are skipped, direct article links (including from Bing News) are read. Empty or JS-only pages are reported and replaced.

Details:

- Results are merged (newest dated headlines first, then background pages), deduped by URL, and cached — 60 seconds for fresh queries so answers never go stale mid-day, 10 minutes for timeless facts.
- The search receipt card shows the source chain and a "N fresh" badge; each result carries its date when known.
- The `news` skill (say "latest AI news") uses the same live feeds for any topic — dated headlines in about 2 seconds with no AI call.
- If the AI engine dies before writing the summary, Aura still runs the search and shows the sources with real excerpts, saying plainly that the summary is missing.
- `/api/web?q=…&freshness=day` is a small read-only endpoint for checking results.

Known limits: Google News redirect links are citations, not readable pages; free engines throttle repeated automated queries from one server IP (the source line shows which ran). For breaking, behind-a-login, or very niche queries, even Google would surface the same few sources.

## Browser

The agent has a real Chromium browser (`browser_open`, `browser_act`, `browser_close`), plus a Browser panel showing the live page and its screenshot.

- Every page the agent visits appears in the chat as a step with a screenshot, the page text, and its links and form fields.
- It can click visible links and buttons, type into fields, press keys, scroll, go back and forward, read the page again, and take screenshots.
- Sessions are per-workspace and ephemeral: fresh cookies, no saved logins or payments, no downloads, one tab, and it closes itself after ten idle minutes. A maximum of three sessions run at once.
- Only public `http`/`https` hosts load. Every request is checked against private, loopback, link-local, and metadata ranges; `file://`, `chrome://` and private addresses are refused.
- Captchas, login walls, and paywalls stop the browser. The agent is instructed to say so instead of guessing.

Enabling it on a server: Chromium and its system libraries must be installed.

```bash
PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium
npx playwright install-deps chromium       # system libraries (Debian/Ubuntu)
```

Browsers installed under `/app/.browsers` (or any Playwright cache) are found automatically; `AURA_CHROMIUM_PATH=/path/to/chrome` overrides the search. If no browser can start, the Browser panel says exactly that, and the agent falls back to the plain public page reader (`web_fetch`).

Known limits: one browser per workspace, no proxy support, and a page that keeps changing may need another `browser_open`. Click automation depends on the model choosing a link that exists on the page; if nothing matches, the error lists the visible links so the next step can succeed.

## Run 24/7 on your own cloud

The agent already runs on a server, not in your browser: chats, terminal files, tasks, and background jobs live in PostgreSQL and in the Node process, so **closing the tab never stops work** — background jobs finish on the server and you see the result when you come back. This preview environment keeps one server process alive for you; to host it yourself around the clock:

**VPS / cloud VM (recommended for the real terminal and long jobs)**

```bash
# On Ubuntu/Debian, as your own user with a real database:
export DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/aura"
export AURA_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # stable secret for any encrypted values
# optional: AURA_AI_BASE_URL=http://localhost:11434/v1  (your own Ollama/LM Studio model)
npm ci && npm run build
# keep it alive with systemd (create /etc/systemd/system/aura.service):
#   [Service] WorkingDirectory=/srv/aura, ExecStart=/usr/bin/npx next start -p 3000, EnvironmentFile=/srv/aura/.env
#   [Install] WantedBy=multi-user.target
sudo systemctl enable --now aura
```

**Serverless (Vercel / Railway / Fly.io / Render):** deploy this repo and set `DATABASE_URL` (+ optionally `SERPER_API_KEY`, `AURA_AI_BASE_URL`). Note serverless functions have execution-time limits, so very long background jobs are best on a VPS; everything saved in PostgreSQL (chats, files, tasks, notes, plans, jobs history) survives restarts and cold starts everywhere.

**Security note (important):** the terminal is deliberately a sandboxed, per-workspace virtual filesystem on the server. It is never a real shell on the host — any visitor must not be able to run host commands. If you want a real cloud shell for yourself, SSH into your own VPS; the app itself only needs the APIs and database above.

## Local development

Install the project dependencies, configure `DATABASE_URL`, prepare PostgreSQL, then apply the schema with `npx drizzle-kit push`. Use `npm run dev` for development.

Production validation:

1. `npx next typegen`
2. `npm exec tsc -- --noEmit --pretty false`
3. `npm run build`

`/api/health` checks the PostgreSQL connection.

## Privacy model

A cryptographically random, HTTP-only cookie identifies a workspace. All data access is scoped to that workspace, and conversation access is checked before messages are returned. This is a personal browser workspace, not an authenticated multi-device account. Clearing cookies removes access; export important work before switching browsers.

Attachments are stored with their conversation messages. AI requests include recent conversation content and text attachments as needed. Workspace memory controls whether saved tasks and notes are automatically added to model context. No API key field exists in the app, and no credential is persisted.

## Keyboard shortcuts

- Command / Control + K: new conversation
- Command / Control + /: search conversations
- Command / Control + comma: settings
- Enter: send
- Shift + Enter: new line
- Escape: close the topmost dialog
