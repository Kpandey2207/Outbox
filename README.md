# Outbox

An email scheduler. A user signs in with Google (or email and password), uploads a list of leads, writes an email, and picks a start time, a delay between sends and an hourly limit. Outbox sends each email at its time through Ethereal SMTP and shows it on a dashboard with search and a Bull Board queue view.

Emails are stored in PostgreSQL and scheduled as BullMQ delayed jobs. Sends survive restarts, are not repeated, and respect per-sender and global hourly limits across any number of workers; emails over a limit are rescheduled, not dropped.

| Layer         | Choice                                                        |
| ------------- | ------------------------------------------------------------- |
| API           | Express 5, TypeScript                                         |
| Database      | PostgreSQL 16 (source of truth)                               |
| Scheduling    | BullMQ delayed jobs on Redis 7 (no cron)                      |
| Rate limiting | One Redis Lua script                                          |
| Email         | Nodemailer over Ethereal SMTP                                 |
| Search        | Elasticsearch 8, with a Postgres fallback                     |
| Auth          | Google OAuth 2.0, plus email and password                     |
| Alerts        | Slack OAuth v2, posted through the install's incoming webhook |
| Queue UI      | Bull Board at`/admin/queues`                                |
| Frontend      | Next.js 16 (App Router), Tailwind 4, TanStack Query           |

## Contents

1. [Prerequisites](#prerequisites)
2. [Running it](#running-it)
3. [Configuration](#configuration)
4. [Architecture](#architecture)
5. [Design](#design)
6. [Failure handling](#failure-handling)
7. [Security](#security)
8. [Frontend](#frontend)
9. [API](#api)
10. [Project structure](#project-structure)
11. [Testing](#testing)
12. [Deploying](#deploying)
13. [Trade-offs](#trade-offs)
14. [Demo script](#demo-script)

## Prerequisites

* Docker with Compose, **or** Node.js 22 plus PostgreSQL 16 and Redis 7 (Elasticsearch 8 is optional).
* For the full feature set: a Google OAuth client and a Slack app (see [OAuth and SMTP setup](#oauth-and-smtp-setup)). Without them you can sign up with email and password, and Slack alerts are off.

## Running it

### Option A: everything in Docker

```bash
cp backend/.env.example backend/.env
# The stack runs in production mode, which refuses the placeholder secret:
sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" backend/.env
# Optional: who may open Bull Board (closed in production mode otherwise).
sed -i.bak "s/^QUEUE_ADMIN_EMAILS=.*/QUEUE_ADMIN_EMAILS=you@example.com/" backend/.env
docker compose up --build
open http://localhost:3000
```

This starts Postgres, Redis (AOF persistence), Elasticsearch, the API, two worker processes and the web app. Migrations run when the API and workers start. `API_URL`, `FRONTEND_URL` and `COOKIE_SECURE` come from `backend/.env`, so the same stack works behind an https tunnel for OAuth: set both URLs to the tunnel's origin. The API does not wait for Elasticsearch.

### Option B: apps on the host

```bash
docker compose up -d postgres redis elasticsearch   # or your own Postgres, Redis, Elasticsearch
cp backend/.env.example backend/.env                # development mode accepts the placeholder secret

# terminal 1: API on :4000
cd backend && npm install && npm run migrate && npm run dev
# terminal 2: a worker (start as many as you like)
cd backend && npm run dev:worker
# terminal 3: dashboard on :3000
cd frontend && npm install && npm run dev
```

The browser only talks to `http://localhost:3000`. Next.js rewrites `/api`, `/auth`, `/integrations` and `/admin/queues` to the API, so the session cookie is first party and no CORS setup is needed. That is why `API_URL`, the public origin for OAuth callbacks, is the frontend origin.

**Without external services.** `DEV_LOGIN_ENABLED=true` adds a "Continue as demo user" button (refused in production and whenever `FRONTEND_URL` is not localhost). `npm run dev:smtp` starts an SMTP catcher on port 2525 that prints each message; point `SMTP_HOST=127.0.0.1 SMTP_PORT=2525` at it. Elasticsearch can be left out (`ELASTICSEARCH_URL=`); search then uses Postgres.

### OAuth and SMTP setup

| Service  | Where                                              | Settings                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google   | Cloud Console → Credentials → OAuth client (Web) | Redirect URI`${API_URL}/auth/google/callback`, e.g. `http://localhost:3000/auth/google/callback`                                                                                                                                  |
| Slack    | api.slack.com/apps → OAuth & Permissions          | Bot scopes`chat:write`, `incoming-webhook`; redirect URL `${API_URL}/integrations/slack/callback`. Slack requires https, so use a tunnel such as ngrok locally.                                                                 |
| Ethereal | nothing required                                   | Each new sender gets its own inbox from`nodemailer.createTestAccount()`. To use a fixed one, create it at https://ethereal.email/create and set `ETHEREAL_USER`/`ETHEREAL_PASS`. Each sent email links to its Ethereal preview. |

## Configuration

All settings are environment variables, validated with zod at startup (`backend/src/config/env.ts`). `backend/.env.example` lists every one with a comment. The ones you are most likely to change:

| Variable                                                                                 | Default                    | Meaning                                                                                            |
| ---------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `API_URL`, `FRONTEND_URL`                                                            | `http://localhost:3000`  | Public origins. Both are the frontend origin when the Next.js rewrites are in front.               |
| `DATABASE_URL`, `REDIS_URL`                                                          | local defaults             | Postgres and Redis.                                                                                |
| `JWT_SECRET`                                                                           | dev placeholder            | Signs OAuth`state`. Production requires 32+ random characters.                                   |
| `DATA_ENCRYPTION_KEY`                                                                  | derived from`JWT_SECRET` | 32 bytes (hex or base64) for encrypting Slack and SMTP credentials at rest.                        |
| `COOKIE_SECURE`                                                                        | on in production           | Set`false` for plain-http setups such as the Docker stack.                                       |
| `QUEUE_ADMIN_EMAILS`                                                                   | unset                      | Who may open Bull Board;`*` for every signed-in user. Unset: open only on a localhost dev setup. |
| `TRUST_PROXY`                                                                          | off                        | Proxy hops allowed to set`X-Forwarded-For`, for per-IP limits behind a load balancer.            |
| `GOOGLE_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`                                  | unset                      | OAuth apps.                                                                                        |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`                                         | unset                      | Search; falls back to Postgres.                                                                    |
| `SMTP_HOST`, `SMTP_PORT`, `ETHEREAL_USER/PASS`                                     | Ethereal                   | SMTP.                                                                                              |
| `WORKER_CONCURRENCY`                                                                   | `5`                      | Jobs in parallel per worker process.                                                               |
| `JOB_ATTEMPTS`, `JOB_BACKOFF_MS`                                                     | `3`, `30000`           | SMTP retries with exponential backoff.                                                             |
| `MIN_DELAY_BETWEEN_SENDS_MS`                                                           | `1000`                   | Minimum gap between two sends from one sender. A campaign can ask for more.                        |
| `MAX_EMAILS_PER_HOUR_PER_SENDER`                                                       | `200`                    | Per-sender hourly ceiling. A campaign can only lower it.                                           |
| `MAX_EMAILS_PER_HOUR_GLOBAL`                                                           | `1000`                   | Hourly ceiling across all senders.                                                                 |
| `SEND_LEASE_MS`                                                                        | `120000`                 | How long a row may stay`sending` before it counts as interrupted (database clock).               |
| `MAX_RECIPIENTS_PER_CAMPAIGN`, `MAX_SCHEDULED_PER_USER`                              | `10000`, `50000`       | Recipients per campaign; unsent emails per user.                                                   |
| `MAX_ATTACHMENT_BYTES`, `MAX_ATTACHMENTS_PER_EMAIL`, `MAX_ATTACHMENTS_TOTAL_BYTES` | 10 MB, 5, 20 MB            | Attachment caps.                                                                                   |
| `RUN_WORKER_IN_API`                                                                    | `false`                  | Run the worker inside the API process (single-instance hosting).                                   |

The compose form reads the campaign caps from `/api/me` and validates against them.

## Architecture

```
                 ┌───────────────────────── Next.js dashboard (:3000) ─────────────────────────┐
 browser ───────▶│ /login /scheduled /sent /compose /emails/:id   rewrites /api /auth /admin → │
                 └─────────────────────────────────────────────┬───────────────────────────────┘
                                                               ▼
┌────────────────────────────── API (Express) ──────────────────────────────┐
│ routes → controllers → services → repositories                            │
│ POST /api/campaigns:                                                      │
│   1. validate + plan every send time                                      │
│   2. INSERT campaign + emails   (one Postgres transaction)                │──▶ PostgreSQL
│   3. index in Elasticsearch (best effort)                                 │──▶ Elasticsearch
│   4. queue.addBulk(jobId = email.id, delay = scheduledAt - now)           │──▶ Redis (BullMQ)
│ Bull Board at /admin/queues                                               │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────── Worker × N (each with concurrency C) ─────────────────────┐
│ on boot: migrate, then re-add jobs missing from Redis                          │
│ every minute: watchdog re-queues overdue rows whose job is gone                │
│ per job:                                                                       │
│   read row ─ sent/failed/cancelled? → skip                                     │
│   claim   ─ UPDATE … SET status='sending', claim_token=<new>                   │
│             WHERE status='scheduled'                                (1 winner) │
│   limit   ─ Redis Lua: throttle + sender/hour + global/hour, atomically        │
│             denied → row back to 'scheduled', job.moveToDelayed(slot)          │
│   mark    ─ UPDATE … SET smtp_started_at=now() WHERE claim_token=<mine>        │
│   send    ─ SMTP with a deterministic Message-ID                               │
│   journal ─ Redis note "accepted by SMTP" (recovers a lost write)              │
│   record  ─ UPDATE … SET status='sent' WHERE claim_token=<mine>                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Postgres records what should be sent and what was sent. BullMQ decides when. Elasticsearch is a read model that `npm run reindex` rebuilds from Postgres.

### Email lifecycle

```
            claim (conditional UPDATE)          SMTP ok
scheduled ─────────────────────────────▶ sending ───────▶ sent
    ▲  │                                   │  │
    │  │ cancel                            │  ├─ 4xx, or failed before DATA,
    │  ▼                                   │  │  attempts left ──▶ scheduled (BullMQ backoff)
    │ cancelled                            │  ├─ 5xx, or out of attempts ──▶ failed
    │                                      │  └─ connection lost after DATA ──▶ failed (outcome unknown)
    └──── limiter says "not yet" ◀─────────┘
          worker died, lease expired:  before SMTP started ──▶ scheduled (sent normally)
                                       SMTP had started    ──▶ failed (outcome unknown),
                                                               or sent if the journal has it
```

Every arrow is one `UPDATE … WHERE status = <expected>`, so two processes racing on a row cannot both make the same transition.

## Design

### Scheduling

Each email is one BullMQ job with `delay = scheduledAt − now`; nothing polls the database. Send times are planned up front (`services/scheduling.ts`) so the dashboard shows them immediately:

```
t[i] = max(t[i-1] + delay, startAt + floor(i / hourlyLimit) hours)
```

The plan is a forecast. The worker's limiter enforces the limits, because it also sees other campaigns on the same sender.

### Restart persistence

* **Worker restart or crash.** Jobs live in Redis. `SIGTERM` lets in-flight jobs finish; a killed worker's job is re-delivered by BullMQ and resolved by the lease rules below.
* **Redis restart.** Redis runs with AOF (`appendfsync everysec`) and `maxmemory-policy noeviction`.
* **Redis data loss, or the API dying between commit and enqueue.** Workers re-add missing jobs from Postgres at boot. A watchdog in every worker also runs once a minute under a Redis lock: a marker key written at boot tells it when Redis was wiped, and it then does the same full reconciliation; otherwise it re-queues rows more than two minutes overdue whose job is missing, failed or finished. Both are idempotent.
* **Database or Redis errors mid-job.** An error before the claim defers the job (5 s, doubling to 10 minutes) without using an attempt. An error after the claim but before SMTP releases the claim, so no row sticks in `sending`.

### Idempotency

| Layer              | Guarantee                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request            | The compose page sends an`Idempotency-Key`. A retry returns the original campaign and re-queues any jobs the first attempt lost; a unique index on `(user_id, idempotency_key)` settles concurrent retries. The same key with different content gets `422`. Without a key, each request is a new campaign. |
| Rows               | `UNIQUE (campaign_id, recipient)`.                                                                                                                                                                                                                                                                             |
| Jobs               | `jobId = email.id`; BullMQ ignores an `add` whose id exists.                                                                                                                                                                                                                                                 |
| Claim              | `scheduled → sending` is a conditional UPDATE that issues a new `claim_token`. One worker wins.                                                                                                                                                                                                             |
| Fencing            | Every later write for the attempt must present that`claim_token`, so a worker that stalled past its lease can no longer send or change the row.                                                                                                                                                                |
| Point of no return | `smtp_started_at` is written before the first SMTP byte. An interrupted attempt without it sent nothing and is resent; one with it is never resent.                                                                                                                                                            |
| SMTP errors        | Retried only on a 4xx or a failure before`DATA`. A 5xx fails at once. A connection lost after `DATA` fails as "outcome unknown", since the server may have the message. One SMTP connection per email is what makes that distinction possible.                                                               |
| Lost`sent` write | On SMTP acceptance a note goes to Redis before the`sent` write. If the write never lands, recovery records `sent` from the note. The note can only upgrade an unknown outcome to `sent`; it never allows a send.                                                                                           |
| Terminal rows      | `sent`, `failed`, `cancelled` are final; a duplicate job reads the row and does nothing.                                                                                                                                                                                                                   |
| Message            | `Message-ID: <email-id@outbox.local>` is deterministic.                                                                                                                                                                                                                                                        |

SMTP and Postgres share no transaction, so one window stays open: SMTP accepts and the process dies before any write. Such an email is marked `failed` ("delivery outcome unknown") and not resent, i.e. **at most once**: a missing email can be sent again deliberately, a duplicate cannot be recalled.

### Concurrency

Any number of worker processes, each with `WORKER_CONCURRENCY`, can run (compose starts two). Correctness comes from the conditional claim in Postgres and the atomic Lua script in Redis, not from how many workers there are. A test runs 3 workers × 5 concurrency over 40 emails and asserts 40 sends.

### Rate limiting and throttling

`queue/rateLimiter.ts` is one Lua script that, atomically:

1. reads the time from Redis (`TIME`), so worker clock skew cannot create room;
2. checks the sender's throttle, the sender's count for this hour and the global count for this hour;
3. only if all pass, increments both counters and records the send.

**Limits.** Per sender per hour: `min(campaign hourly limit, MAX_EMAILS_PER_HOUR_PER_SENDER)`. Global: `MAX_EMAILS_PER_HOUR_GLOBAL`. Windows are UTC clock hours.

**Throttle.** The gap between two sends from one sender is `max(campaign delay, MIN_DELAY_BETWEEN_SENDS_MS)`, measured from the last send. A job that arrives inside the gap is given a reserved slot (the next free time, which is then marked taken), so contenders line up one gap apart instead of colliding again. Short waits (≤1 s) happen in process; longer ones move the job to its slot. Throttle waits are not counted as reschedules.

**Over the hourly limit** the email is rescheduled, not dropped: the row goes back to `scheduled` with `reschedule_count + 1`, and the job is moved with `job.moveToDelayed()`, which does not use an attempt. Overflow is counted per window and per limit, and the n-th overflow goes to `nextHour + floor(n / perHour) hours + (n mod perHour) × delay`, where `perHour` is the limit or fewer if the delay cannot fit that many in an hour. Rejected emails therefore spread over the following hours instead of all waking at once. The worker adds a second of grace so a clock slightly ahead of Redis cannot wake an email early.

**Example.** 1,000 emails on one sender at 10:00, 2 s delay, limit 200: the planner assigns 200 emails from 10:00:00 to 10:06:38, the next 200 from 11:00, up to 14:06:38. If another campaign uses the same sender in the same hour, the limiter defers the extra sends into the next free slots and Slack is told once.

### Slack alerts

"Connect Slack" runs Slack's OAuth v2 flow; `incoming-webhook` makes Slack ask for a channel. The token, channel and webhook URL are stored encrypted per user. Alerts go through the webhook, which posts to the chosen channel even if the bot was never invited (`chat.postMessage` would fail with `not_in_channel`); older installs fall back to `chat.postMessage`.

An alert is posted when a sender uses its last slot of the hour, or when the limiter first defers a send (which also covers the global limit). A `SET NX` key limits this to one message per sender or global limit per hour across workers. Alerts run in the background with a 5 s timeout, and errors are logged, so Slack never affects sending.

### Search

Emails are indexed on create (before their jobs are queued) and on each status change (in the background). Recipients are indexed with the standard analyzer and with `uax_url_email` for whole addresses. Search is a fuzzy `multi_match` filtered to the user and view, then re-read from Postgres, dropping hits that have since left the view. If Elasticsearch is unavailable, search falls back to Postgres `ILIKE`.

### Queue dashboard

Bull Board at `/admin/queues` shows every user's jobs, so it is limited to `QUEUE_ADMIN_EMAILS` and linked from those users' menu.

## Failure handling

| What fails                                        | What happens                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| SMTP 4xx or unreachable                           | Back to`scheduled`, retried with exponential backoff; `failed` after the last attempt.                         |
| SMTP 5xx                                          | `failed` at once.                                                                                                |
| Connection lost after the message was handed over | `failed`, "delivery outcome unknown", never retried.                                                             |
| Worker killed mid-attempt                         | After the lease: resent if SMTP had not started; otherwise`failed` (unknown), or `sent` if the journal has it. |
| `sent` write fails after SMTP accepted          | Retried in process; otherwise recovered as`sent` from the journal. Never resent.                                 |
| API dies between commit and enqueue               | The watchdog enqueues the rows; a retry with the same`Idempotency-Key` does so at once.                          |
| Redis restarts or loses data                      | AOF replays the jobs; anything lost is restored by the watchdog within a minute.                                   |
| Postgres down or slow                             | Jobs are deferred before claiming without using attempts. Queries time out after 30 s.                             |
| Error after claim, before SMTP                    | Claim released, job retried.                                                                                       |
| Elasticsearch down or slow                        | Scheduling and sending continue; search uses Postgres;`npm run reindex` repairs.                                 |
| Slack down or token revoked                       | Logged; sending unaffected.                                                                                        |
| Email cancelled while due                         | The claim fails (row is`cancelled`) and the job completes without sending.                                       |

## Security

Covered by `backend/test/security.test.ts`.

* **Sessions.** Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` by default in production). Postgres stores only its SHA-256. Logout revokes it.
* **Google OAuth.** `state` is a signed 10-minute token bound to a nonce cookie. The ID token's signature, audience, expiry and `email_verified` are checked. Email sign-up does not verify the address, so a first Google sign-in to an address registered with a password removes that password, revokes its sessions, and cancels the mail, uploads and Slack install created under it. An account is bound to the first Google identity that claims it.
* **Passwords.** scrypt. Attempts are capped per email per client (10 per 15 minutes), so a stranger cannot lock the owner out, with a ceiling of 100 per email.
* **Slack OAuth.** Same `state` check; the callback must be completed by the user who started it. Tokens and webhook URLs never reach the browser or logs; the token is revoked on disconnect.
* **Secrets.** Slack tokens, webhook URLs and SMTP passwords are encrypted with AES-256-GCM. `.env` is git-ignored; `.env.example` holds placeholders. The frontend has no secrets.
* **Authorization.** Every query on user data filters by the signed-in user's id; another user's id returns 404.
* **CSRF and CORS.** Writes whose `Origin`, `Referer` or `Sec-Fetch-Site` shows another site are refused. CORS allows exactly `FRONTEND_URL`.
* **Rate limits.** Redis counters per IP (sign-in) and per user (writes, scheduling, uploads, senders, Slack test), answering `429` with `Retry-After`. The client IP is the socket address unless `TRUST_PROXY` is set. Locally and in Docker all requests come through the Next.js proxy, so per-IP limits are shared there.
* **Input limits.** Zod validates every body, query and id. Campaigns are bounded in recipients, start date (one year), total body size, and unsent emails per user; bodies must contain text or an image.
* **Uploads.** Kept in memory with size and count limits. The extension must match the file's first bytes; SVG and HTML are refused. Downloads use `nosniff` and a sandbox CSP. Pending uploads are capped per user under a lock.
* **XSS.** Bodies are sanitised with DOMPurify when rendered and pasted (no style tags, forms, frames, `class` or `id`), links get `noopener`, and the body is rendered with `contain: paint` so it cannot overlay the page. The dashboard sends a CSP and `X-Frame-Options: DENY`.
* **Errors and logs.** Clients get a code and message only. Third-party errors are reduced to name, code and a redacted message; stacks are redacted; request logs drop query strings.
* **Bull Board** is limited to `QUEUE_ADMIN_EMAILS`, and the demo login is refused off localhost.
* **Account enumeration.** The combined sign-in/sign-up form reveals whether an address has an account. This is inherent to a one-form design; the rate limits bound probing.
* **Infrastructure.** Compose publishes Postgres, Redis and Elasticsearch on `127.0.0.1` only. Containers run as the `node` user.

## Frontend

Screens follow the Figma frames in [`docs/figma/`](docs/figma): Login, Scheduled, Sent, Compose (with the Send Later picker) and Email detail. Lists poll every 5 seconds and load 50 emails at a time. Every view has loading, empty and error states.

Two readings of the design against the brief:

* The brief puts name, email, avatar and logout "in the top header"; the Figma puts them in the sidebar's profile card, so they are there.
* The brief's "Schedule" button is the Figma's **Send Later**: it opens the start-time picker, and **Done** schedules.

Beyond the brief:

* Star, archive and delete, with Starred and Archived views. Deleting a scheduled email cancels it in the same conditional `UPDATE`, so it cannot race a send.
* Attachments (shown in the Figma): images and documents, up to 5 files of 10 MB and 20 MB in total, uploaded on pick and linked to the campaign in its create transaction.
* A Filter menu per mailbox and a send-details panel on each email.
* A phone layout below 768px: top bar, bottom tabs with counts, a Compose button, cards instead of table rows, and bottom sheets. Checked at 320 to 1440px.

## API

All `/api` routes need the session cookie. Errors are `{ error: { code, message, details? } }`.

| Method      | Path                                                                            | Purpose                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/auth/config`                                                                | Sign-in methods this server offers                                                                                                                                                                                   |
| GET         | `/auth/google` → `/auth/google/callback`                                   | Google sign-in                                                                                                                                                                                                       |
| POST        | `/auth/email`                                                                 | Email and password sign-in; creates the account if new                                                                                                                                                               |
| POST        | `/auth/dev-login`                                                             | Demo user, only with`DEV_LOGIN_ENABLED` on localhost                                                                                                                                                               |
| POST        | `/auth/logout`                                                                | Sign out                                                                                                                                                                                                             |
| GET         | `/api/me`                                                                     | Profile, senders, Slack status, feature flags, campaign caps                                                                                                                                                         |
| GET/POST    | `/api/senders`                                                                | List senders / create an Ethereal sender                                                                                                                                                                             |
| POST        | `/api/leads/parse`                                                            | Upload a CSV (`file`); returns de-duplicated addresses                                                                                                                                                             |
| POST        | `/api/attachments`                                                            | Upload up to 5 files (`files`)                                                                                                                                                                                     |
| GET/DELETE  | `/api/attachments/:id`                                                        | Download / remove an unscheduled upload                                                                                                                                                                              |
| POST        | `/api/campaigns`                                                              | Schedule. Body:`senderId, subject, body, recipients[], startAt, delayBetweenSeconds, hourlyLimit, attachmentIds[]`. Header `Idempotency-Key`: `201` new, `200` replay, `422` reused with different content |
| GET         | `/api/emails?status=scheduled\|sent\|starred\|archived&only=&q=&page=&pageSize=` | List or search                                                                                                                                                                                                       |
| GET         | `/api/emails/counts`                                                          | Counts per view                                                                                                                                                                                                      |
| GET         | `/api/emails/:id`                                                             | Email with attachments                                                                                                                                                                                               |
| PATCH       | `/api/emails/:id`                                                             | `{ starred?, archived? }`                                                                                                                                                                                          |
| DELETE      | `/api/emails/:id`                                                             | Hide; cancels a scheduled email                                                                                                                                                                                      |
| GET         | `/integrations/slack/install` → `/callback`                                | Slack OAuth                                                                                                                                                                                                          |
| POST/DELETE | `/api/integrations/slack/test`, `/api/integrations/slack`                   | Test message / disconnect                                                                                                                                                                                            |
| GET         | `/admin/queues`                                                               | Bull Board (operators)                                                                                                                                                                                               |
| GET         | `/health`                                                                     | Postgres and Redis health                                                                                                                                                                                            |

## Project structure

```
backend/src
├── config/         env (zod), logger
├── db/             pool, transactions, migration runner, SQL migrations
├── models/         domain types
├── repositories/   all SQL, including every status transition
├── services/       scheduling, campaigns, emails, attachments, search, auth, senders, alerts
├── integrations/   Nodemailer, Elasticsearch, Slack, Google
├── queue/          Redis connection, BullMQ queue, Lua rate limiter, delivery journal, Bull Board
├── workers/        send processor, worker factory, reconciliation and watchdog
├── controllers/    HTTP ↔ service
├── routes/         URL wiring and request limits
├── middleware/     auth, CSRF origin check, rate limits, validation, errors
├── validation/     request schemas
├── scripts/        reindex, local SMTP catcher
├── server.ts       API entry
└── worker.ts       worker entry
backend/test        integration tests against real Postgres and Redis

frontend/src
├── app/            login, (dashboard)/scheduled|sent|starred|archived|compose|emails/[id]
├── components/     ui/, layout/, emails/, compose/, attachments/
├── hooks/          TanStack Query hooks
└── lib/            API client, types, formatting, sanitising
```

## Testing

```bash
cd backend
npm test          # needs Postgres and Redis; creates DB outbox_test on first run, uses Redis db 15
npm run typecheck
cd ../frontend && npm run lint && npm run build
```

73 backend tests run against real Postgres and Redis; only SMTP is faked. They cover:

* **Limiter:** 200 concurrent calls with a limit of 25 allow exactly 25; per-sender budgets are separate and the global one shared; throttle slots are reserved in arrival order; overflow is per limit and never tighter than the delay.
* **Workers:** 3 workers × 5 concurrency send 40 emails once each; duplicate and replayed jobs do not resend; two campaigns on one sender keep the minimum gap; over-limit sends move to the next hour with one Slack alert.
* **Failures:** transient SMTP errors retry once; unknown-outcome and refused sends never retry; a crashed `sending` row is resolved by whether SMTP started and by the journal; a worker that lost its claim cannot send; a database outage before the claim uses no attempts.
* **Persistence:** jobs survive a worker restart; jobs deleted from Redis are restored at boot and, with the worker running, by the watchdog.
* **API:** campaigns, idempotent replays and `422` on changed content, CSV parsing, attachments, star/archive/delete, validation, Elasticsearch fallback.
* **Security:** cross-user access, session revocation, token hashing, Google reclaim and identity binding, CSRF, CORS, rate limits and spoofed `X-Forwarded-For`, lockout per client, Bull Board access, encryption at rest, spoofed file types, input bounds, upload and scheduling caps under concurrency, log redaction.

## Demo script

1. **Sign in** with Google; a default Ethereal sender is created.
2. **Connect Slack** from the profile menu and pick a channel.
3. **Compose:** upload a CSV of about 20 leads, delay 2 s, hourly limit 5, Send Later a minute from now. Scheduled shows 20 emails (5 in the first hour, the rest later).
4. **Delivery:** rows move to Sent; open one and follow "View delivered message on Ethereal". When the fifth email of the hour goes out, Slack gets one message.
5. **Rate limit:** schedule a second campaign on the same sender to start now. Its emails move to the next hour ("Moved 1 time…"), with no second Slack message.
6. **Bull Board:** open Queue dashboard (your email must be in `QUEUE_ADMIN_EMAILS` in Docker) and show delayed and completed jobs.
7. **Restarts:** `docker compose kill worker`, then `docker compose up -d worker`; sending continues on time. Then `docker compose exec redis redis-cli FLUSHALL` with everything running: within a minute the worker logs "Redis lost data; reconciling every pending email" and "restored missing jobs from postgres".
8. **Concurrency:** `docker compose up -d --scale worker=4` and send a larger list; each recipient appears in Sent once.
9. **Search:** search "lead3" or a subject word.
