# Patient Reminder Bot — Plan

## What is this

Telegram/WhatsApp bot for a doctor (Dr. Lev, neurologist in UAE).
Doctor sends text/voice → bot tracks patients, sends follow-up reminders.

**Status:** plan only, zero code written.

## Critical constraints

- Contains medical data (names, diagnoses, phone numbers) — compliance review needed before production use
- Patient data is sent to LLM API (OpenRouter/OpenAI) — privacy implications
- This is a SEPARATE project from the Chrome extension in this repo
- Must be moved to its own repository before real use

## Architecture

```
Doctor (Telegram/WhatsApp)
  ↓
Messenger adapter (polling or webhook)
  ↓
LLM router (OpenAI-compatible API via OpenRouter)
  ↓ function calls
Tool executor (add_patient, list, note, set_reminder...)
  ↓
SQLite (patients, visits, notes, reminders)
  ↓
Scheduler (cron every hour → check due reminders)
  ↓
Outbound message to patient (WhatsApp when available, or text for doctor to send manually)
```

## Tech stack

- Runtime: Node.js + TypeScript
- LLM: OpenAI SDK → OpenRouter (model configurable in .env)
- DB: better-sqlite3 (single file, no server)
- Telegram: grammy or node-telegram-bot-api
- WhatsApp: Meta Cloud API (later, requires business verification)
- Voice: OpenAI Whisper API
- Deploy: VPS + Docker + pm2

## Database schema

```sql
doctors
  id
  telegram_id
  name
  language (en/ru/ar)
  created_at

patients
  id
  doctor_id
  name
  diagnosis
  phone
  remind_every_days
  last_visit_date
  next_reminder_date
  created_at

notes
  id
  patient_id
  text
  created_at

reminders_log
  id
  patient_id
  sent_at
  channel (telegram/whatsapp/manual)
  status (sent/failed/skipped)

invites
  id
  code (e.g. inv_lev_a1b2c3)
  doctor_name
  used (boolean)
  used_by_telegram_id
  created_at
```

## LLM tools (function calling)

```
add_patient(name, diagnosis, remind_every_days?, phone?)
list_patients(filter?)
add_note(patient_name, text)
set_reminder(patient_name, days)
remove_patient(patient_name)
set_phone(patient_name, phone)
patient_details(patient_name)
stats()
```

## File structure

```
patient-reminder-bot/        ← separate repo
├── src/
│   ├── index.ts              # entry point, picks messenger
│   ├── cli.ts                # CLI mode for local testing
│   ├── llm.ts                # OpenAI SDK wrapper, system prompt, tool defs
│   ├── tools.ts              # tool implementations (add, list, note...)
│   ├── db.ts                 # SQLite setup + queries
│   ├── scheduler.ts          # cron: check reminders, notify doctor
│   ├── messenger/
│   │   ├── interface.ts      # abstract: onMessage, send, sendWithButtons
│   │   ├── telegram.ts       # Telegram adapter
│   │   └── whatsapp.ts       # WhatsApp adapter (stub for now)
│   ├── voice.ts              # Whisper: audio buffer → text
│   ├── invite.ts             # invite link generation + validation
│   └── logger.ts             # structured JSON logging to stdout + file
├── tests/
│   ├── tools.test.ts         # unit: each tool function
│   ├── llm.test.ts           # integration: prompt → tool call → result
│   └── scheduler.test.ts     # unit: reminder logic
├── scripts/
│   └── create-invite.ts      # CLI: generate invite link
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

## Implementation order

### Day 1: working CLI (4 hours)

1. Init repo, npm init, tsconfig, .env.example
2. `db.ts` — SQLite schema, migrations
3. `tools.ts` — add_patient, list_patients, add_note (pure functions, no LLM)
4. `llm.ts` — system prompt, tool definitions, OpenAI SDK call
5. `cli.ts` — readline loop: input → LLM → tool → response
6. 3 tests: add patient, list, add note
7. **Test manually: type commands, verify SQLite has data**
8. Commit, push

### Day 2: Telegram bot + deploy (4 hours)

1. `messenger/telegram.ts` — polling, onMessage, send
2. `messenger/interface.ts` — shared interface
3. `invite.ts` — validate invite code from /start deep link
4. `index.ts` — pick CLI or Telegram based on env
5. `Dockerfile` + `docker-compose.yml`
6. Deploy to VPS, verify bot responds
7. `scheduler.ts` — cron every hour, check next_reminder_date
8. **Test: add patient via Telegram, wait for reminder**
9. SQLite backup cron: daily copy to /backups/
10. Commit, push

### Day 3: give to Dr. Lev

1. `scripts/create-invite.ts` → generates `t.me/bot?start=inv_lev_xxx`
2. Send link to Lev
3. Watch operator channel for his messages
4. Fix whatever breaks
5. **No new features — only fix what Lev actually hits**

### Later (only after Lev uses it for 1+ week):

- Voice messages (Whisper)
- Onboarding flow (language pick, tutorial)
- WhatsApp adapter (Meta Cloud API)
- Patient-facing reminders via WhatsApp
- Stats command
- Multi-language system prompt
- Weekly digest

## Known risks

| Risk | Mitigation |
|------|-----------|
| better-sqlite3 won't compile | Dockerfile with build-essential pre-installed |
| OpenRouter model slug wrong | .env.example with exact tested slug |
| Whisper misheard voice | Show transcription, let doctor correct |
| LLM doesn't call tools | Test system prompt with edge cases, pin model version |
| VPS disk dies | Daily SQLite backup to S3/remote |
| Doctor sends patient data to LLM API | Document this risk, discuss with Lev |
| No medical data compliance | Not production-ready until reviewed |
| Bot process crashes | Docker restart policy: always |
| WhatsApp not available yet | Fallback: show message text for doctor to send manually |

## What this plan does NOT cover

- HIPAA/GDPR/UAE PDPL compliance (needed before real patients)
- End-to-end encryption of patient data
- Multi-doctor support (currently single-doctor)
- Web dashboard
- Payment/billing
- Mobile app

## Decision log

- 2025-03-09: Decided on separate repo (not inside chat-export-plugin)
- 2025-03-09: Invite links instead of promo codes for onboarding
- 2025-03-09: CLI first, Telegram second — validate LLM tools before adding messenger complexity
- 2025-03-09: SQLite over Postgres — single file, no server, good enough for 1 doctor
- 2025-03-09: No onboarding flow in MVP — add only after watching how Lev uses it
