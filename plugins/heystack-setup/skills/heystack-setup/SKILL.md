---
name: heystack-setup
description: Use when adding Heystack observability/tracing to a project, or when the user mentions @heystack/otel, "set up Heystack", "add observability/tracing", or an ingest key like sk_live_…. Detects the framework (Next.js, Cloudflare Workers/OpenNext, Node/Express/Fastify, edge) and package manager, installs @heystack/otel, and wires the correct runtime pattern with the ingest key as an environment variable. Critical: the wrong runtime pattern is a production no-op (the Node SDK cannot run on Workers/Edge), so detection matters.
---

<!-- MAINTAINER: this file is mirrored to heystack-hq/heystack-plugins (the
     published plugin repo). Re-sync that repo after changes here.
     0.9.0: automatic LLM gen_ai enrichment for outbound calls on /workers —
     detects OpenAI/Anthropic/CF AI Gateway/Google; attaches model, tokens,
     finish_reason; opt-in captureContent + redact for prompts/completions.
     0.8.0: Workers AI, Queue producer, Service binding instrumentation on /workers.
     0.7.0: sampling: { remote: true } on /workers — fetch head-sampling rate
     from Heystack config at runtime (change from dashboard, no redeploy; fails
     open on cold start / unreachable config).
     0.6.0: sampling: { rate } head sampling on /workers (drop fresh root traces
     before export; parent-respecting; deterministic by trace-id).
     0.5.0: getUser (identity enrichment), instrumentBindings (D1/KV/R2/Vectorize
     child spans), automatic outbound-fetch CLIENT spans + traceparent injection,
     withSpan/addEvent manual span helpers.
     0.4.3: feedback-loop guard extended to Node path.
     0.3.2: registers an OTel ContextManager so suppression ACTUALLY takes effect;
     Workers now REQUIRE nodejs_compat; hostname-accurate self-span filter;
     OpenNext accessor race fixed; Node initHeystack idempotent + optional
     instrumentations; drain timeout; Durable Objects need manual instrumentation
     (instrument() only wraps the default-export handler). -->

# Setting up Heystack (@heystack/otel)

Heystack is observability + security for AI apps. `@heystack/otel` ships traces to the Heystack ingest endpoint (`https://ingest.heystack.dev`) over OTLP/JSON. The package is **runtime-aware** with separate entry points — **using the wrong one breaks the app or silently sends nothing**, so detect the runtime first.

> **Requires `@heystack/otel` `>=0.9.0` (prefer latest).** Pin it. **0.9.0** adds automatic LLM gen_ai enrichment for outbound calls on `/workers` — detects OpenAI/Anthropic/CF AI Gateway/Google and attaches model, token counts, finish reason; opt-in `ai.captureContent` captures prompt/completion text (strongly recommended for AI-app RCA). **0.8.0** adds Workers AI, Queue producer, and Service binding instrumentation. **0.7.0** adds `sampling: { remote: true }` to `/workers` — fetch the head-sampling rate from the Heystack dashboard at runtime so you can tune it without redeploying; fails open on cold start or if the config can't be reached. **0.6.0** adds `sampling: { rate }` head sampling to `/workers` — drop a deterministic fraction of fresh root traces before export to control egress and ingest cost; parent-respecting (inbound sampled contexts are always recorded). **0.5.0** adds identity enrichment (`getUser`), D1/KV/R2/Vectorize child spans (`instrumentBindings`), automatic outbound-`fetch` CLIENT spans with `traceparent` injection (distributed tracing), and `withSpan`/`addEvent` manual span helpers to `/workers`. 0.4.3 extended the self-trace feedback-loop guard to the Node path. **0.3.2** registered an OpenTelemetry ContextManager so the exporter's self-trace suppression actually takes effect (it was a silent no-op in 0.3.1) — Workers now require the `nodejs_compat` compatibility flag; the self-span filter is hostname-accurate; Node `initHeystack` is idempotent + accepts a custom `instrumentations` array; drain timeout added. 0.3.1 made `instrument()` forward `queue`/`scheduled`/`tail` (and trace them) so Queue/Cron Workers still deploy. 0.3.0 made Next-on-OpenNext auto-flush via the Cloudflare request context. (0.2.0 made the Next.js entry auto-detect workerd and removed the old top-level default `initHeystack({ apiKey })` — use the subpath entries `/node`, `/next`, `/workers`.)

## Step 0 — Get the ingest key (never hardcode it)

The user creates an app in the Heystack console (https://console.heystack.dev) and gets an `sk_live_…` key, shown once. The key is ALWAYS read from an environment variable named `HEYSTACK_API_KEY` — **never paste it into committed source**. If you don't have the key, ask the user to create an app in the console and paste the key, or set `HEYSTACK_API_KEY` themselves.

## Step 1 — Detect the package manager

Check the lockfile in the project root:

Install with the `>=0.9.0` pin (0.9.0 adds automatic LLM gen_ai enrichment; 0.8.0 adds Workers AI/Queue/Service binding spans; 0.7.0 adds remote sampling; 0.6.0 adds head sampling; 0.5.0 adds identity enrichment, binding tracing, outbound-fetch tracing, and manual span helpers):

| Lockfile | Manager | Install command |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm add "@heystack/otel@>=0.9.0"` |
| `yarn.lock` | yarn | `yarn add "@heystack/otel@>=0.9.0"` |
| `bun.lockb` | bun | `bun add "@heystack/otel@>=0.9.0"` |
| `package-lock.json` (or none) | npm | `npm install "@heystack/otel@>=0.9.0"` |

## Step 2 — Detect the runtime, then apply the matching pattern

Inspect `package.json` dependencies + config files. **Match in this order** (Next first — it covers its own Cloudflare/OpenNext case now):

### A. Next.js (any deploy target, incl. Cloudflare/OpenNext)  →  `@heystack/otel/next`
Signals: `next` in dependencies. This is the entry for Next regardless of where it deploys — Vercel/Node **or** Cloudflare via OpenNext. You do NOT need to know the deploy target: `registerHeystack` auto-detects Node vs Cloudflare workerd at runtime and picks the right exporter (Node SDK on Node, fetch-based exporter on workerd — where the Node SDK's `node:http` exporter would silently send nothing). It's also a no-op on the Edge runtime, so it's safe to call unconditionally.

Create/extend `instrumentation.ts` (or `src/instrumentation.ts`) at the project root:
```ts
export async function register() {
  const { registerHeystack } = await import("@heystack/otel/next");
  await registerHeystack({ service: "my-app" }); // apiKey from process.env.HEYSTACK_API_KEY
}
```
Put `HEYSTACK_API_KEY=sk_live_…` in `.env.local` (and the host's env / `wrangler secret put HEYSTACK_API_KEY` for OpenNext prod). On Cloudflare/OpenNext there is no per-request `ExecutionContext` handed to `registerHeystack`, but **as of `@heystack/otel >=0.3.0` flushing is automatic**: the export runs inside the Cloudflare request context, so the exporter borrows that request's `ctx.waitUntil` (via `@opennextjs/cloudflare`'s `getCloudflareContext`) to keep the isolate alive until the export `fetch()` POST completes — no manual hook needed. For other workerd setups *without* `@opennextjs/cloudflare`, `import { flushHeystack } from "@heystack/otel/workers"` and call it from a response hook (or `ctx.waitUntil(flushHeystack())` if you have a ctx); `flushHeystack()` awaits the export fetch.

### B. Standalone Cloudflare Workers (hand-written `export default { fetch }`, NOT Next)
Signals: a `wrangler.toml`/`wrangler.jsonc` with a hand-written Worker entry, `@cloudflare/workers-types`, `"main"` pointing at a Worker `fetch` handler — and **no** `next`. The Node SDK CANNOT run here.

**Two integration options — pick one (or both):**

| | Option A — native OTel export (zero code) | Option B — @heystack/otel/workers SDK |
|---|---|---|
| Setup | Cloudflare dashboard + one `wrangler.toml` line | `npm install` + one wrapper call |
| Signals | Traces + `console.log` logs | Traces + logs + manual spans |
| Binding spans | Outbound `fetch` only | D1 / KV / R2 / Vectorize child spans |
| User context per request | No | Yes (`getUser`) |
| Code change | None | One `instrument()` wrapper |

Use **Option A** when the user just wants traces and logs quickly, can't or doesn't want to install the SDK, or is doing a quick proof-of-concept. Use **Option B** (or both) when they need D1/KV/R2/Vectorize binding depth, per-request `getUser` context, custom `withSpan`/`addEvent` spans, or `sampling: { remote: true }` from the dashboard. The two options are complementary.

#### Option A — Cloudflare native OTel export (zero code) [beta]

No SDK install or code changes needed. Cloudflare exports traces and `console.log` logs natively to any OTLP/JSON endpoint.

**Constraints — state these honestly to the user:**
- **Open beta**, no code changes required. Requires a **Workers Paid plan** (free-tier Workers can't use native export — use Option B instead). Free during the beta; afterward, spans are billed as observability events on the Workers Paid plan, sharing the Workers Logs quota/pricing — see [Cloudflare's Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current terms.
- Traces + logs only — Cloudflare does not yet support emitting Worker metrics via native export. Heystack derives RED metrics (rate, errors, p50/p95/p99 duration) server-side from spans, so the Metrics tab in the Heystack console still works.
- No binding depth — native export captures HTTP-level `fetch` subrequests, not D1 queries, KV reads, R2 operations, or Vectorize calls. For those, use Option B.

**Step 1 — Create an export destination** in the Cloudflare dashboard (Workers & Pages → Observability → Export destinations → Add destination → Custom OTLP):
- Traces endpoint: `https://ingest.heystack.dev/v1/traces`
- Logs endpoint: `https://ingest.heystack.dev/v1/logs`
- Header: `Authorization: Bearer sk_live_…` (the ingest key from the Heystack console → Settings → Ingest keys)
- Encoding: **JSON** (Heystack accepts OTLP/JSON only; protobuf is not supported)

**Step 2 — Enable observability in `wrangler.toml`:**
```toml
[observability]
enabled = true
# head_sampling_rate = 0.2   # optional: 0.0–1.0, controls what fraction of requests generate traces
```

Deploy and make a request. Traces and logs appear in Heystack within seconds. No `HEYSTACK_API_KEY` env var needed; the Bearer token is set in the dashboard destination.

#### Option B — @heystack/otel/workers SDK (binding + business-span depth)  →  `@heystack/otel/workers`

Wrap the default export:
```ts
import { instrument } from "@heystack/otel/workers";

export default instrument(worker, {
  service: "my-worker",           // REQUIRED. apiKey defaults to env.HEYSTACK_API_KEY
  getUser: (req) => ({            // optional: attach user/session identity per request
    id: req.headers.get("x-user-id") ?? undefined,
    session: req.headers.get("x-session-id") ?? undefined,
  }),
  instrumentBindings: true,       // optional: auto child spans for D1/KV/R2/Vectorize
  sampling: { remote: true },     // optional: control the capture rate from the Heystack
                                  // dashboard without redeploying (fails open on cold start)
  // sampling: { rate: 0.2 },     // alternative: fixed rate — keep ~20% of fresh root traces
});
```

**`instrument()` config options:**

| Option | Type | Notes |
|---|---|---|
| `service` | `string` | **Required.** The name that appears in the Heystack console for this Worker. |
| `apiKey` | `string?` | Defaults to `env.HEYSTACK_API_KEY` — set via `wrangler secret put HEYSTACK_API_KEY`. |
| `getUser` | `(req: Request) => { id?, session?, requestId? }` | Called per request. Attaches `enduser.id`, `session.id`, or a request identifier to every captured request. |
| `instrumentBindings` | `boolean \| string[]` | `true` = auto child spans for all detected D1/KV/R2/Vectorize bindings. `string[]` = only the named bindings. Default `false`. |
| `sampling` | `{ rate?: number } \| { remote: true }` | `{ rate }`: head-sampling rate 0–1 (default `1` = keep all). `{ remote: true }`: fetch the rate from the Heystack dashboard — change it without redeploying. Cold start and unreachable config both fail open (keep everything). |
| `ai` | `{ captureContent?: boolean; redact?: (s: string) => string; maxContentChars?: number }` | LLM gen_ai enrichment for outbound calls to OpenAI / Anthropic / CF AI Gateway / Google. Model, tokens, and finish reason are captured automatically. Set `captureContent: true` to also capture prompt/completion text — **strongly recommended for AI-app RCA** (off by default). Use `redact` to scrub sensitive content before it leaves the Worker. |

**`instrument()` must be the OUTERMOST wrapper** if other middleware also wraps the handler:
```ts
export default instrument(withOtherMiddleware(worker), { service: "my-worker" });
```
Set the key as a Worker secret: `wrangler secret put HEYSTACK_API_KEY`.

**What's traced automatically:**
- **`fetch`** — a SERVER span per request. Inbound `traceparent` is continued; a `traceparent` response header is set so browser/mobile clients can read it.
- **Outbound `fetch`** — each subrequest made while a request is active gets a CLIENT child span, and `traceparent` is injected so a downstream Heystack-instrumented service continues the same trace.
- **LLM API calls** — outbound calls to OpenAI (`api.openai.com`), Anthropic (`api.anthropic.com`), Cloudflare AI Gateway (`*.gateway.ai.cloudflare.com`), and Google (`generativelanguage.googleapis.com`) are automatically enriched with `gen_ai.*` OTel semantic-convention attributes (model, token counts, finish reason) on the CLIENT span. Enable `ai.captureContent: true` to also capture prompt/completion text — **strongly recommended for AI-app RCA**.
- **`queue`** — a CONSUMER span per batch (queue name + message count).
- **`scheduled`** — an INTERNAL span per invocation (cron expression).
- **Binding calls** (when `instrumentBindings` is set) — child spans for D1 queries, KV reads/writes, R2 operations, and Vectorize queries.
- **Client enrichment** — `enduser.id`/`session.id` from `getUser`, `client.address` from `CF-Connecting-IP`, and `geo.*` from `req.cf`.

**Manual spans inside a handler (`withSpan` / `addEvent`):**
```ts
import { instrument, withSpan, addEvent } from "@heystack/otel/workers";

// inside your fetch handler:
const result = await withSpan("parse-payload", { source: "body" }, async () => {
  addEvent("parsing-started");
  return JSON.parse(await req.text());
});
```
`withSpan(name, attrs?, fn)` creates a child span, records exceptions, and ends in `finally`. `addEvent(name, attrs?)` adds an event to the active span (no-op when none is active).

> **REQUIRED for Workers on `@heystack/otel >=0.3.2`: enable `nodejs_compat`.** The context manager uses `AsyncLocalStorage` for per-request isolation. Add to `wrangler.toml`:
> ```toml
> compatibility_flags = ["nodejs_compat"]
> ```
> Without it the SDK falls back to a synchronous context manager — suppression still works, but cross-`await` span parenting and per-request isolation degrade to best-effort.

> **Durable Objects are NOT auto-instrumented.** `instrument()` only wraps the keys of the default-export handler object (`fetch`/`queue`/`scheduled`/…). Durable Objects are **separate named class exports**, so their methods run untraced. Instrument a DO manually with the global tracer (`trace.getTracer("heystack")`) inside `context.with(trace.setSpan(...))`, `span.end()` in a `finally`, and flush with `this.state.waitUntil(flushHeystack())`. Wrap the default export (or call `initHeystackWorkers`) so the global provider is registered before the DO runs.

### C. Plain Node / Express / Fastify / NestJS (long-running Node server)  →  `@heystack/otel/node`
Signals: `express`/`fastify`/`@nestjs/*`, or a plain Node entry with no edge runtime. Initialise as the VERY FIRST import in the entry file (before the framework), so auto-instrumentation can patch modules:
```ts
import { initHeystack } from "@heystack/otel/node";
initHeystack({ apiKey: process.env.HEYSTACK_API_KEY!, service: "my-app" });
// ...then the rest of your imports/app...
```
This bundles auto-instrumentations (HTTP, common libs) and registers a SIGTERM/SIGINT flush. Put `HEYSTACK_API_KEY` in `.env` (loaded before this runs). Pass `debug: true` to log export activity while verifying.

> Tip for entry-ordering in Node: if your build can't guarantee this is first, use `node --import` with a small `heystack.mjs` that calls `initHeystack`, or your framework's instrumentation hook.

### D. Browser / web frontend (SPA, React/Vue/Svelte client, any in-browser UI)  →  `@heystack/otel/web`
Signals: a client-rendered web app — a Vite/CRA SPA, or the **client** of a Next/Remix/etc. app — where you want **session replay** plus client→backend trace correlation. This is **in addition to** any server-side entry above (A/B/C trace the backend; `/web` records the browser). Call `instrumentWeb` once, early in the client entry (e.g. `main.tsx`):
```ts
import { instrumentWeb } from "@heystack/otel/web";

await instrumentWeb({
  apiKey: import.meta.env.VITE_HEYSTACK_API_KEY, // same ingest key; exposed to the client build
  service: "my-web-app",
});
```
`instrumentWeb` records session replay and injects a W3C `traceparent` on outgoing `fetch` calls so replays correlate with backend traces. It returns a `stop()` function and is a **no-op on the server** (SSR-safe). **Sampling and masking are controlled from the console** — tell the user to enable replay under **Settings → Session replay** for the app (nothing records until it's enabled there). Masking is strict by default (all text inputs/passwords masked); fine-tune in the DOM with `data-hs-mask` (mask an element), `data-hs-block` (block a region), `data-hs-unmask` (reveal a trusted element). The optional `sampleRate` is only a local override.

> Note: the browser bundle includes the ingest key, so a `/web` key is necessarily public — that's expected for client telemetry. Sampling/masking are enforced server-side from the console config.

## Step 3 — Set the environment variable

- Local: `.env` / `.env.local` with `HEYSTACK_API_KEY=sk_live_…` (ensure `.env*` is gitignored).
- Cloudflare Workers: `wrangler secret put HEYSTACK_API_KEY`.
- Vercel/Netlify/etc.: add `HEYSTACK_API_KEY` in the platform's env settings (and to the right environments).

## Step 4 — Verify

Run the app and make one request. Within a few seconds, traces appear in the Heystack console under the app whose `service` name you set. If nothing shows:
- Confirm `HEYSTACK_API_KEY` is actually set in the running environment.
- For `@heystack/otel/node`, pass `debug: true` to see OTel export logs.
- Confirm the `service` here matches the app's service name in the console.
- Confirm `@heystack/otel` is `>=0.7.0` (0.7.0 adds remote sampling; 0.6.0 adds head sampling; 0.5.0 adds identity enrichment, binding tracing, outbound-fetch spans, and manual span helpers; older versions silently send nothing on OpenNext/workerd or — pre-0.3.2 — can loop the ingest POST).
- On Cloudflare Workers/OpenNext, confirm `nodejs_compat` is in `compatibility_flags` (required by `>=0.3.2` for the context manager / suppression).
- Heavy Node startup or overhead? Pass a slimmer `instrumentations: [...]` array to `initHeystack` instead of the default `getNodeAutoInstrumentations()` (which patches ~40 libs).
- For a Next app on OpenNext/Cloudflare, the `/next` entry handles workerd automatically — no separate Workers wiring needed. If spans still don't show, call `flushHeystack()` from a response hook for guaranteed delivery.

## Runtime decision table (quick reference)

| Where the code runs | Entry to import | Key via |
|---|---|---|
| Next.js — any target (Vercel/Node **or** Cloudflare/OpenNext) | `@heystack/otel/next` (`registerHeystack`, auto-detects workerd) | `.env.local` / platform env / `wrangler secret` |
| Standalone Cloudflare Worker — zero-code fast start (traces + logs, no binding depth) | CF native OTel export — dashboard destination + `[observability] enabled = true` in `wrangler.toml` | Bearer token set in CF dashboard destination |
| Standalone Cloudflare Worker — binding/business depth (D1/KV/R2/Vectorize) | `@heystack/otel/workers` (`instrument`, outermost wrapper) | `wrangler secret` |
| Long-running Node server | `@heystack/otel/node` (`initHeystack`) | `.env` / platform env |
| Browser / web frontend (session replay) | `@heystack/otel/web` (`instrumentWeb`, in the client entry) | public client env var; enable replay in **Settings → Session replay** |
| Just need the export URL/headers | `@heystack/otel` (`buildExporterConfig`) | n/a (pure) |
