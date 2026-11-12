# Slotline

A day planner for a two-van mobile phone-repair business where **every job is a PayPal deposit** and **money state drives the schedule**. A booking is firm only once a PayPal authorization exists; when money misbehaves (declined capture, refund, dispute, late balance) the schedule reflows: an agent proposes ranked options, the operator approves one, and approval mints a short-lived execution grant before any PayPal call runs ("authorize twice": the customer approves the hold in PayPal, the operator separately approves execution).

Built for the PayPal AI Hackathon (Devpost). Sandbox only; never the live API.

## For judges

- **Live demo:** https://slotline.tailcdec7a.ts.net (PayPal **sandbox**, hosted until the end of judging).
- **Logins:** the operator password, the PayPal sandbox buyer account and the dev-tools secret are in the Devpost submission's testing instructions.
- **Operator dashboard** (`/`): Dana's board. Sign in with the operator password.
- **Customer booking page** (`/book`): no sign-in. Pay with the PayPal sandbox buyer.
- **Dev tools** (the **Dev** panel on the dashboard): paste the dev-tools secret to trigger a declined capture, a refund or a dispute on demand.
- **No network?** Any page with `?demo=1` runs an in-browser simulation of the same API.

**How AI is used.** When money misbehaves on a booking (declined capture, refund, dispute, late balance), Slotline asks **Claude Opus 5.5** (Anthropic API, official `@anthropic-ai/sdk`, structured output against a Zod schema) for 1–3 ranked recovery options plus customer messages. Claude only proposes. Code (`validatePlan`: the constraint solver and the booking state machine) decides what is feasible and what every amount is. Nothing runs until Dana approves one option. Approval mints a 15-minute execution grant limited to that option's bookings, actions and amounts, and every PayPal call checks the grant first. If Claude is slow, refuses or is unreachable, a deterministic rules planner takes over (logged as `planner.fallback`).

**Tools used.**
- **Claude Opus 5.5** via the Anthropic API (`@anthropic-ai/sdk`): the scheduling agent that proposes recovery plans.
- **PayPal Server SDK** (`@paypal/paypal-server-sdk`): Orders v2 (AUTHORIZE intent), authorize, capture, void and refund.
- **PayPal REST APIs:** Invoicing v2 (create, send, QR, reminders), Disputes and webhook signature verification.
- **PayPal JS SDK Buttons** on the booking page.
- **PayPal sandbox webhooks**, verified and idempotent.
- **Bryntum Scheduler Pro** (trial): the live timeline that reflows when money state changes.
- **Next.js 16, SQLite (better-sqlite3), Zod.**
- **Claude Code** was used as a coding assistant while building.

## Run

Requirements: Node.js 24, pnpm 11 (`corepack enable`).

```bash
pnpm install
cp .env.example .env.local        # defaults: PAYPAL_MODE=mock, LLM_PROVIDER=rules (zero keys needed)
pnpm dev                          # http://localhost:3000 (dashboard) and /book (customer page)
```

In development an empty `OPERATOR_PASSWORD` leaves the dashboard and every operator route **open** (startup prints a warning banner); set one in `.env.local` to try the sign-in. Production (`next start`, Docker) refuses to start without the secrets listed under [Security](#security):

```bash
pnpm build
OPERATOR_PASSWORD="$(openssl rand -base64 24)" DEV_TOOLS_SECRET="$(openssl rand -hex 24)" \
MOCK_WEBHOOK_SECRET="$(openssl rand -hex 32)" pnpm start      # or put the three in .env.local
```

`PAYPAL_MODE=mock LLM_PROVIDER=rules` runs the whole product with no credentials: a deterministic mock PayPal (ids like `MOCK-ORDER-1`) that also "delivers" the webhook PayPal would send after each call, signed and verified through the same webhook route. The first request seeds Dana's demo day (today in `OPERATOR_TZ`); `AUTO_RESEED=daily|empty|off` controls reseeding (default `daily`: a new operator day reloads the demo day).

| Command | What it does |
|---|---|
| `pnpm test` | vitest: reducer table, webhook route, solver, grants, planner (incl. a mock LLM), sandbox gateway (SDK + REST stubbed, no network), mock end-to-end |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm tsx scripts/sandbox-smoke.ts` | real sandbox round trip (needs sandbox credentials; see below) |
| `pnpm tsx scripts/register-webhook.ts` | creates the sandbox webhook for `APP_BASE_URL/api/paypal/webhook` |
| `docker compose up -d --build` | production build in `node:24-bookworm-slim`, SQLite persisted in `./data` (needs more than 5 GB of RAM for Docker; see [Docker](#docker)) |

Environment (`.env.local`, never committed):

| Variable | Default | Notes |
|---|---|---|
| `PAYPAL_MODE` | `mock` | `sandbox` uses the official `@paypal/paypal-server-sdk` against `api-m.sandbox.paypal.com` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | – | sandbox REST app credentials (server only) |
| `PAYPAL_WEBHOOK_ID` | – | id printed by `scripts/register-webhook.ts`; required to verify sandbox webhooks |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | – | client id for the JS SDK buttons (also served at runtime by `GET /api/config/public`) |
| `LLM_PROVIDER` | `rules` | `gemini` (`GEMINI_API_KEY`, `GEMINI_MODEL`) or `groq` (`GROQ_API_KEY`, `GROQ_MODEL`); falls back to `rules` without a key, on error, or after `PLANNER_TIMEOUT_MS` (20 s) |
| `OPERATOR_PASSWORD` | – | operator sign-in (dashboard, `/evidence/:id`, every operator API route). **Required in production**; empty in development = open, with a startup warning |
| `SESSION_SECRET` | – | optional key for the session cookie (at least 32 characters); default: derived from `OPERATOR_PASSWORD` (scrypt), so changing the password signs everyone out |
| `DEV_TOOLS_SECRET` | – | enables the dev tools; send it as the `x-dev-secret` header (operators only). Unset or `off` = dev tools off. Production refuses to start when it is unset, `change-me` or shorter than 16 characters (`off` is accepted) |
| `DATABASE_PATH` | `./data/slotline.db` | SQLite (WAL) |
| `OPERATOR_TZ` | `America/Los_Angeles` | working hours 08:00–18:00 are in this zone |
| `APP_BASE_URL` | `http://localhost:3000` | public URL (booking links, webhook registration) |
| `MOCK_WEBHOOK_DELAY_MS` | `1500` | mock mode: delay of the simulated webhook after each API call (`0` = off) |
| `MOCK_WEBHOOK_SECRET` | public default | mock mode: HMAC key of the simulated webhooks. The default is in the repo, so production with `PAYPAL_MODE=mock` refuses to start without its own key |

## Security

- **Operator sign-in.** One shared password, `OPERATOR_PASSWORD`. `POST /api/auth/login {password}` sets `slotline_session`: an HMAC-SHA256-signed token (`v1.<expiry>.<nonce>.<sig>`), `HttpOnly`, `SameSite=Lax`, `Path=/`, 12 hours, and `Secure` in production (serve it over HTTPS; a Cloudflare Tunnel does that; `localhost` also works). `POST /api/auth/logout` clears the cookie and revokes that token, and any open stream on it ends. `GET /api/auth/me` says whether the browser is signed in. Failed sign-ins are throttled: after 10 in a minute, `429` with `retry-after` (globally, since behind a tunnel all clients share one address). The dashboard and `/evidence/:id` show a sign-in form when signed out. If an API call or the stream gets a 401, the page goes back to the form instead of retrying.
- **What is gated.** Every operator route answers `401 {"code":"UNAUTHENTICATED"}` without the cookie. The check is `requireOperator()` / `operatorRoute()` in `src/server/http.ts`, inside the route handlers. Next 16's `proxy.ts` is documented as an optimistic pre-filter, not an authorization layer, so it is not used. The gated routes are `GET /api/state`, `GET /api/stream`, `PATCH /api/bookings/:id`, `POST /api/bookings/:id/{capture,void,refund,invoice,remind}`, `GET /api/bookings/:id/evidence`, all of `/api/plans/*` and all of `/api/dev/*`. The dev routes also still need `x-dev-secret`. `tests/auth.test.ts` walks every `route.ts` and fails if a new route is neither gated nor on the public list.
- **What is public.** The routes the customer page and PayPal need: `POST /api/bookings`, `POST /api/bookings/:id/{order,authorize}`, `GET /api/bookings/:id` (the `/book?booking=<id>` resume link; it returns only that booking's essentials, with no email, notes, or capture, refund, invoice or dispute ids), `GET /api/availability` (times, van ids and a free flag, no customer data), `GET /api/config/public`, `POST /api/paypal/webhook` (signature-verified) and the three `/api/auth/*` routes. The unguessable booking id is the customer's handle on their own booking.
- **Fail-closed startup.** `src/instrumentation.ts` runs `src/server/startup.ts` once when the server starts. With `NODE_ENV=production` it prints the reasons and exits 1 in these cases: `OPERATOR_PASSWORD` is unset; `DEV_TOOLS_SECRET` is unset, `change-me` or shorter than 16 characters (`off` disables the dev tools); `PAYPAL_MODE=mock` without a `MOCK_WEBHOOK_SECRET` of its own; `SESSION_SECRET` is set but shorter than 32 characters. Development keeps the defaults. There are runtime backstops as well: in production the example dev secret counts as "dev tools off", and the public mock webhook key is never used.
- **Grants are consumed atomically.** Approving a plan claims it with one `UPDATE … WHERE status='proposed'`. Using a grant claims it with one `UPDATE grants SET status='used' WHERE id=? AND status='active' AND expires_at > now`, done before any PayPal call. Two concurrent approvals, or two concurrent money requests holding one grant id, run exactly once (`tests/grants.test.ts`).

## PayPal sandbox setup

1. In the [PayPal developer dashboard](https://developer.paypal.com/dashboard/) (Sandbox), create a REST app. Copy its client id and secret into `.env.local` as `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`; set `PAYPAL_MODE=sandbox`.
2. Use a sandbox **business** account (merchant) and a sandbox **personal** account (buyer) in the same country.
3. Turn on **Negative Testing** for the business account (Sandbox → Accounts → business account → Settings) so `PayPal-Mock-Response` works.
4. Run `pnpm tsx scripts/sandbox-smoke.ts`: it creates two AUTHORIZE orders, prints approve links (log in as the sandbox buyer), then authorizes, captures with `INSTRUMENT_DECLINED` (expects HTTP 422), captures, replays the capture with the same `PayPal-Request-Id`, refunds, voids the second authorization, and creates/sends/QRs/reminds an invoice and lists disputes. Set `SANDBOX_BUYER_EMAIL` to address the invoice to the sandbox buyer.
5. Register the webhook (next section).

Tokens: the SDK's client-credentials token is cached per process and shared with the REST helper (`src/server/paypal/client.ts`); it is refreshed 5 minutes before expiry and once on any 401.

## Webhooks

- Endpoint: `POST /api/paypal/webhook`. PayPal needs a public HTTPS URL; on a home server use a tunnel (e.g. Cloudflare Tunnel) and set `APP_BASE_URL` to it, then run `pnpm tsx scripts/register-webhook.ts` and put the printed id in `PAYPAL_WEBHOOK_ID`.
- Subscribed events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED` (Payments v2 name, normalised to `PAYMENT.CAPTURE.DENIED`), `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.REFUNDED`, `INVOICING.INVOICE.PAID`, `CUSTOMER.DISPUTE.CREATED`.
- Handling, in order: read the **raw** body → verify the signature through the gateway (sandbox: `POST /v1/notifications/verify-webhook-signature` with the `paypal-transmission-id/-time/-sig`, `paypal-cert-url`, `paypal-auth-algo` headers, `PAYPAL_WEBHOOK_ID`, and the event embedded byte-for-byte; mock: HMAC over PayPal's signed string `transmissionId|time|webhookId|crc32(body)`) → **400 and nothing recorded** on failure → record by event id (a replay answers **200** and changes nothing) → unknown event types are recorded and ignored (200) → apply through the state machine → log → broadcast over SSE → maybe plan. An internal error answers 500 so PayPal retries (it retries up to 25 times over 3 days); the database transaction rolled back, so the retry is processed.
- Our own API results (authorize, capture, void, refund) are mapped to the same event names (`source: "api"`), so the later webhook for the same resource is a no-op (`idempotent` or `stale` in the log).
- Dev tools (`x-dev-secret`): `POST /api/dev/inject {fixture, bookingId}` injects a PayPal-shaped fixture (`src/server/fixtures/*.json`) with the booking's ids; `POST /api/dev/replay {eventId?}` re-delivers the latest webhook/dev event (re-signed in mock mode) and must answer `duplicate`.

## Architecture

```
browser (dashboard, /book) ── JSON + SSE ──▶ Next.js 16 route handlers (src/app/api/**)
                                               │
       ┌───────────────────────────────────────┼──────────────────────────────────────┐
       ▼                                       ▼                                      ▼
  bookings.ts / invoices.ts            webhook.ts (raw body,                 planner/ (rules | anthropic | gemini | groq,
  (create, order, authorize,           verify, normalise)                     AI SDK 7 generateText+Output.object,
   capture, void, refund, invoice)            │                               read-only PayPal tools in sandbox)
       │   paypal/calls.ts (logged)           │                                      │
       ▼                                      ▼                                      ▼
  PaypalGateway ─ SandboxGateway (official SDK + rest.ts)          validatePlan (solver + state machine
                └ MockGateway (deterministic, echoes webhooks)      decide feasibility and amounts)
       │                                      │                                      │
       └──────────────▶ pipeline.applyMoneyEvent ◀───────────────────────────────────┘
                         record (idempotent by id) → reduce (pure state.ts) → persist (SQLite)
                         → log (5 actors) → bus (SSE) → maybePlan
                                                       │
                         operator approves ──▶ grants.ts: mint 15-min grant (bookings, actions,
                                               max amount, currency) → check before every call → used once
```

- `src/shared/types.ts` is the contract between the backend and the dashboard.
- `src/server/state.ts`: pure reducer over the table in BUILD-PLAN §4; illegal transitions throw `IllegalTransition` and are logged, never applied. A late delivery for a resource already reflected (same PayPal id) is `stale`, not illegal.
- `src/server/solver.ts`: working hours, durations (screen 60, battery 45, diagnostic 30, water 90 min), 30-minute travel buffer, no overlap, repack (only unpaid jobs move, at most 2 h), waitlist promotion.
- `src/server/db.ts`: SQLite tables `resources, bookings, events, log, plans, grants, invoices` (+ `meta`, `mock_objects`).
- Actors in the log: `customer` (booking, checkout), `operator` (approve/reject, drag, dev tools), `agent` (plans, read-only tool calls), `system` (PayPal calls, execution), `paypal` (webhooks and fixtures).
- API: `GET /api/state`, `GET /api/stream`, `GET /api/config/public`, `GET /api/availability`, `POST /api/bookings`, `GET|PATCH /api/bookings/:id`, `POST /api/bookings/:id/{order,authorize,capture,void,refund,invoice,remind}`, `GET /api/bookings/:id/evidence`, `GET /api/plans/:id`, `POST /api/plans/:id/{approve,reject}`, `POST /api/plans/propose`, `POST /api/paypal/webhook`, `POST /api/dev/{seed,inject,replay}`, `POST /api/auth/{login,logout}`, `GET /api/auth/me`. Which ones need the operator session is under [Security](#security).

## Unhappy paths

| What happens | How Slotline reacts |
|---|---|
| Capture declined (`INSTRUMENT_DECLINED`, `TRANSACTION_REFUSED`, ...; HTTP 422 or a `DECLINED` capture) | Normalised to `PAYMENT.CAPTURE.DENIED` (`source: "api"`); the job turns amber (`declined`); the agent proposes: give the slot to the first waitlisted customer + void the hold (+ chase an open balance), or keep the slot and retry the capture, or release it. |
| Capture pending | `pending` (yellow) until `PAYMENT.CAPTURE.COMPLETED` or `DENIED` arrives. |
| Authorization voided (by us, or when it reaches its 30-day validity) | `released`: slot freed; if not caused by our own grant, the agent offers the slot to the waitlist or repacks the van. |
| Refund | `refunded`: slot freed; same reflow options. A refund before any capture is illegal and only logged. A `PENDING` refund keeps the slot until the webhook confirms. |
| Dispute | `disputed` (red flag) from any paid state; options: contest with the evidence pack (`GET /api/bookings/:id/evidence`: order, authorization, capture, refund, invoice, dispute, events, timeline, plans, grants) or refund. |
| Balance unpaid | Invoicing v2 invoice (create → send → QR) and reminders; `INVOICING.INVOICE.PAID` flips `balanceState` to `paid`. |
| Forged or unsigned webhook | 400, nothing recorded or changed, logged as `webhook.rejected`. |
| Replayed webhook | Same event id → 200, no-op, logged as `event.duplicate`. |
| Out-of-order webhook (e.g. capture before authorization) | Recorded, logged as `booking.illegal`, not applied. |
| LLM down, slow (`PLANNER_TIMEOUT_MS`, 45 s on the demo) or keyless | Rules planner runs instead; logged as `planner.fallback`. |
| Model hallucinates a booking, van, time or amount | `validatePlan` marks the action infeasible (amounts always come from the booking); options without a feasible action are dropped. |
| Schedule changed between proposal and approval | The option is re-validated at approval; newly infeasible actions are skipped and left out of the grant; a superseded plan cannot be approved (409). |
| Grant misuse | Action type not allowed, booking not covered, amount over the remaining maximum, expired (15 min), or already used → 403, no PayPal call. |
| Execution fails midway | Plan `failed`, grant revoked (kept for audit), remaining actions not run, and a fresh plan is proposed. |
| Double clicks / retries | `/order` and `/authorize` are idempotent per booking; every PayPal create/authorize/capture/void/refund carries `PayPal-Request-Id` (deterministic per grant action), so a retry cannot double-charge. |

## Using the dashboard

Three pages: `/` (Dana's operator dashboard), `/book` (the customer booking page) and `/evidence/:id` (a printable dispute evidence pack). The dashboard and the evidence pack ask for the operator password when `OPERATOR_PASSWORD` is set (**Sign out** is in the header). `/book` never does.

**No backend? Add `?demo=1`.** Every page then talks to an in-browser simulation of the API (`src/lib/client/demo-data.ts` + `demo-backend.ts`): same contract, same state machine, mock PayPal ids, no network calls. It is also the screenshot mode. Add `&scene=` to start from a moment in the story: `declined` (Ahmed's capture just failed, agent card open), `reflowed` (option A already executed), `refund`, `dispute`. Client-side navigation keeps the simulation, so a booking made on `/book?demo=1` shows up on `/?demo=1`.

### The board

- **Header**: `PayPal: sandbox|mock` and `Planner: gemini|groq|rules` badges, the stream status (`Live`, `Reconnecting`, `Demo data`, or `Sign in` when the stream was refused), and **Sign out**.
- **Money strip**: authorized holds, captured deposits, money at risk (declined or disputed), open balance invoices, jobs with no deposit yet.
- **Timeline** (Bryntum Scheduler Pro): one row per van plus a **Waitlist** lane where waiting customers sit at the time they asked for. 07:00–19:00 in the operator's time zone, whatever the viewer's zone; hatched before 08:00 and after 18:00; dashed green boxes are open windows that fit a job after the 30-minute travel buffer.

| Bar | State | Means |
|---|---|---|
| grey, dashed outline | quoted | booked, no money yet |
| blue outline | approved | buyer approved in PayPal, no authorization yet |
| green | held | authorization holds the deposit; the slot is firm |
| yellow | pending | capture in PayPal review |
| dark green | confirmed | deposit captured |
| amber, striped, warning icon | declined | capture declined; slot at risk |
| red, flag icon | disputed | dispute open; drag is locked |
| (gone) | released / refunded | the bar leaves the board |

A bar rings once when its state changes, and moves (promotion, repack, drag) animate.

- **Hover** a bar: customer, service, times, deposit and balance status, and every PayPal id (order, authorization, capture, refund, invoice, dispute).
- **Click** a bar: an inspector opens above the tabs with click-to-copy PayPal ids, "Ask the agent", "Log for this job", and "Evidence pack" for disputes.
- **Drag** a bar to another time or van: `PATCH /api/bookings/:id`. If the server answers 409, the bar snaps back and a toast lists the conflicts. **Drag its end** to resize; durations are set by service, so the server keeps its length and the bar snaps back.
- **Right-click** a bar: ask the agent for options, filter the log to this job, open the evidence pack.

### Right panel

- **Agent**: open proposals first. Each option lists its actions as chips: ✓ feasible or ✕ infeasible (reason underneath, checked by the solver, not the model), money actions with their amount. The footer shows the grant that approval would mint (allowed actions, maximum amount, 15 minutes). **Approve** runs the option under that grant and the card then shows the grant id, its status and expiry, and the result of every action with its PayPal refs. **Reject** closes the proposal. Draft customer messages are collapsed under the options. A new proposal pulls this tab forward.
- **Waitlist**: waiting customers and jobs on the board without a deposit. **Send booking link** copies `/book?booking=<id>`, which opens straight at the deposit step for that booking. **Ask the agent** requests options for it.
- **Log**: newest first, coloured by actor (customer, operator, agent, system, paypal). The chips at the top toggle actors and show counts; clicking a customer name filters to that booking. Refs are click-to-copy chips; PayPal ids are blue.
- **Dev** (shown only when the server has `DEV_TOOLS_SECRET` set): type the secret once (kept in this browser's localStorage, sent as `x-dev-secret`), pick a booking, then run the negative capture test (`capture: INSTRUMENT_DECLINED`, `TRANSACTION_REFUSED`, or success), inject any webhook fixture, replay the latest webhook (expect `duplicate`, HTTP 200, no change), call void / refund / invoice / remind directly, or reset the day to the seed.

The board stays current through `GET /api/stream`. If the stream drops it reconnects with backoff, resyncs from `GET /api/state` on every reconnect, and polls `/api/state` every 5 s until it is back.

### Customer page (`/book`)

Pick a service and a time today (30-minute steps; slots that look full are marked `waitlist`, from `GET /api/availability`, which the solver computes and which carries no customer data), enter a name and email, and book. If no van is free you land on the waitlist and pay nothing. Otherwise the deposit step appears:

- `PAYPAL_MODE=sandbox` with a client id (`NEXT_PUBLIC_PAYPAL_CLIENT_ID` or `GET /api/config/public`): PayPal Buttons with `intent=authorize`. `createOrder` calls `POST /api/bookings/:id/order`, `onApprove` calls `POST /api/bookings/:id/authorize`. Use a sandbox buyer account.
- `PAYPAL_MODE=mock`: a **Simulate PayPal approval (mock)** button calls the same two endpoints against the mock gateway and shows each step.

The confirmation shows the booking state (`Deposit held`), the PayPal order and authorization ids, and a link to Dana's board.

### Evidence pack (`/evidence/:id`)

Opened from a disputed booking. It shows the booking, the statement of facts, PayPal references and objects (order, authorization, capture, refund, invoice, dispute), operator grants, and the booking's full event log. **Print / save as PDF** prints it without the page chrome.

### The demo in five clicks

1. `/book` → book a screen repair → **Simulate PayPal approval (mock)** → **See it on Dana's board**: the new bar is green (`held`).
2. **Dev** → `capture: INSTRUMENT_DECLINED` on a held job → **Run**: the bar turns amber and an agent card appears.
3. **Approve A**: the hold is voided, the waitlisted customer glides from the Waitlist lane into the slot, and the log shows operator, system and paypal entries under one grant.
4. **Dev** → `PAYMENT.CAPTURE.REFUNDED` on a confirmed job: the bar leaves the board and the agent proposes how to fill the gap.
5. **Dev** → `CUSTOMER.DISPUTE.CREATED` on a paid job → right-click → **Open evidence pack**. **Replay latest webhook** in Dev answers `duplicate` and changes nothing.

If `next dev` reloads the page in a loop after a restart, stop it, delete `.next/dev` and start it again (a stale Turbopack dev cache).

## Docker

`docker compose up -d --build` builds everything inside the image with `./Dockerfile`. That build needs more than 5 GB of RAM: `next build` peaked at 5.2 to 7 GB on the Mac, and it is OOM-killed (exit 137) in a 4 GB Docker VM. On a smaller machine, build `.next` on the host (or in CI) and ship a runtime-only image with `Dockerfile.runtime`:

```bash
pnpm install && pnpm build                       # on the host; NEXT_PUBLIC_* values are inlined here
COPYFILE_DISABLE=1 tar --no-xattrs -cz --exclude .next/cache --exclude .next/dev \
  Dockerfile.runtime package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc next.config.ts public .next \
  | docker build -f Dockerfile.runtime -t slotline:latest -
mkdir -p data                                    # on Linux: sudo chown 1000:1000 data
docker compose up -d --no-build                  # docker-compose.yml runs image slotline:latest with .env.local and ./data
```

- The build context goes in through `tar` because the repo `.dockerignore`, which `./Dockerfile` uses, excludes `.next`. With BuildKit (`docker buildx`), `docker build -f Dockerfile.runtime -t slotline:latest .` also works, because it reads `Dockerfile.runtime.dockerignore`.
- Without compose: `docker run -d -p 3000:3000 -v "$PWD/data:/app/data" --env-file <file> slotline:latest`. Unlike compose, `docker run --env-file` keeps inline `# comments` as part of the value, so give it a file without them (`.env.example` has them).
- `node_modules` is not copied from the host: `better-sqlite3` is a native module built for the host's OS and CPU. The image installs the production dependencies itself (`pnpm install --prod`, with python3, make and g++ in a throwaway stage), which takes little memory.
- Both images run `next start` with `NODE_ENV=production`, so `.env.local` (or `-e`) must provide `OPERATOR_PASSWORD`, `DEV_TOOLS_SECRET` (or `off`) and, in mock mode, `MOCK_WEBHOOK_SECRET`. Otherwise the container exits at once and its log says why.
