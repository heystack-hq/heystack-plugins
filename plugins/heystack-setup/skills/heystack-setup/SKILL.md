---
name: heystack-setup
description: Use when adding Heystack observability/tracing to a project, or when the user mentions @heystack/otel, "set up Heystack", "add observability/tracing", or an ingest key like sk_live_…. Detects the framework (Next.js, Cloudflare Workers/OpenNext, Node/Express/Fastify, edge) and package manager, installs @heystack/otel, and wires the correct runtime pattern with the ingest key as an environment variable. Critical: the wrong runtime pattern is a production no-op (the Node SDK cannot run on Workers/Edge), so detection matters.
---

<!-- MAINTAINER: the public skill mirror (apps/landing/public/heystack-setup.md)
     must be re-synced after the 0.3.0 + 0.3.1 + 0.3.2 wording was added here.
     0.3.0: Next-on-OpenNext now auto-flushes via the Cloudflare request context;
     workerd detection uses the WebSocketPair global; instrument() sets the
     global provider. 0.3.1: instrument() forwards queue/scheduled/tail (and
     traces queue/scheduled); the exporter suppresses self-tracing on its
     ingest POST. 0.3.2: registers an OTel ContextManager so that suppression
     ACTUALLY takes effect (it was a no-op in 0.3.1) — Workers now REQUIRE the
     nodejs_compat flag; hostname-accurate self-span filter; OpenNext accessor
     race fixed; Node initHeystack idempotent + optional `instrumentations`;
     drain timeout; Durable Objects need manual instrumentation (instrument()
     only wraps the default-export handler, not named DO class exports). -->

# Setting up Heystack (@heystack/otel)

Heystack is observability + security for AI apps. `@heystack/otel` ships traces to the Heystack ingest endpoint (`https://ingest.heystack.dev`) over OTLP/JSON. The package is **runtime-aware** with separate entry points — **using the wrong one breaks the app or silently sends nothing**, so detect the runtime first.

> **Requires `@heystack/otel` `>=0.3.0` (prefer `>=0.3.2`).** Pin it. 0.3.0 makes Next-on-OpenNext auto-flush via the Cloudflare request context (no manual hook needed), hardens workerd detection so it survives `nodejs_compat`, and has `instrument()` register the global provider so nested spans export. 0.3.1 makes `instrument()` forward `queue`/`scheduled`/`tail` (and trace queue/scheduled) so Queue/Cron Workers still deploy. **0.3.2 is the important correctness release:** it registers an OpenTelemetry **ContextManager** so the exporter's self-trace **suppression actually takes effect** — in 0.3.1 it was a silent no-op, so the ingest POST could feed a feedback loop. Because that manager uses `node:async_hooks`, **Cloudflare Workers now require the `nodejs_compat` compatibility flag** (a sync fallback keeps suppression working otherwise). 0.3.2 also makes the self-span filter hostname-accurate, fixes an OpenNext flush race, makes the Node `initHeystack` idempotent + accept a custom `instrumentations` array, and adds a flush drain timeout. (0.2.0 made the Next.js entry auto-detect Cloudflare workerd and removed the old top-level default `initHeystack({ apiKey })` — use the subpath entries `/node`, `/next`, `/workers`.)

## Step 0 — Get the ingest key (never hardcode it)

The user creates an app in the Heystack console (https://console.heystack.dev) and gets an `sk_live_…` key, shown once. The key is ALWAYS read from an environment variable named `HEYSTACK_API_KEY` — **never paste it into committed source**. If you don't have the key, ask the user to create an app in the console and paste the key, or set `HEYSTACK_API_KEY` themselves.

## Step 1 — Detect the package manager

Check the lockfile in the project root:

Install with the `>=0.3.2` pin (the no-op-suppression fix + nodejs_compat requirement landed in 0.3.2):

| Lockfile | Manager | Install command |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm add "@heystack/otel@>=0.3.2"` |
| `yarn.lock` | yarn | `yarn add "@heystack/otel@>=0.3.2"` |
| `bun.lockb` | bun | `bun add "@heystack/otel@>=0.3.2"` |
| `package-lock.json` (or none) | npm | `npm install "@heystack/otel@>=0.3.2"` |

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

### B. Standalone Cloudflare Workers (hand-written `export default { fetch }`, NOT Next)  →  `@heystack/otel/workers`
Signals: a `wrangler.toml`/`wrangler.jsonc` with a hand-written Worker entry, `@cloudflare/workers-types`, `"main"` pointing at a Worker `fetch` handler — and **no** `next`. The Node SDK CANNOT run here. Wrap the default export:
```ts
import { instrument } from "@heystack/otel/workers";

export default instrument(
  {
    async fetch(req, env, ctx) {
      // ...your worker...
      return new Response("ok");
    },
  },
  { service: "my-worker" }, // apiKey defaults to env.HEYSTACK_API_KEY
);
```
**`instrument()` must be the OUTERMOST wrapper** if other middleware also wraps the handler, so the request span covers everything inside it:
```ts
export default instrument(withOtherMiddleware(worker), { service: "my-worker" });
```
Set the key as a Worker secret, not a file: `wrangler secret put HEYSTACK_API_KEY`. The wrapper auto-creates a server span per request and flushes via `ctx.waitUntil`, waiting for the export `fetch()` to actually complete before the isolate is torn down (earlier versions could drop the trace on fast handlers). As of `@heystack/otel >=0.3.0` it also registers the **global** tracer provider, so nested spans created via the global `trace.getTracer()` API export too — you get a trace tree, not just the top SERVER span. As of `@heystack/otel >=0.3.1`, `instrument()` **forwards `queue`/`scheduled`/`tail` (and any other exported handler)** untouched — so wrapping a Queue/Cron Worker no longer drops the handler Cloudflare requires for deploy — and traces `queue`/`scheduled` too. As of `0.3.2` the exporter's self-tracing suppression is genuinely effective (it registers an OTel ContextManager — in 0.3.1 it was a no-op), so there's no feedback loop with the host's outbound-`fetch` auto-instrumentation (e.g. Next/OpenNext); 0.3.2's ContextManager also gives cross-`await` parent→child span linking and per-request context isolation.

> **REQUIRED for Workers/OpenNext on `@heystack/otel >=0.3.2`: enable `nodejs_compat`.** The ContextManager uses `node:async_hooks`, available on workerd only under the Node compat flag. Add it to `wrangler.toml`:
> ```toml
> compatibility_flags = ["nodejs_compat"]
> ```
> Without it the SDK falls back to a synchronous context manager — suppression still works, but cross-`await` span parenting and per-request isolation degrade to best-effort.

> **Durable Objects are NOT auto-instrumented.** `instrument()` only wraps the keys of the default-export handler object (`fetch`/`queue`/`scheduled`/…). Durable Objects are **separate named class exports**, so their methods run untraced. Instrument a DO manually with the global tracer (`trace.getTracer("heystack")`) inside `context.with(trace.setSpan(...))`, `span.end()` in a `finally`, and flush the export with `this.state.waitUntil(flushHeystack())`. Still wrap the default export (or call `initHeystackWorkers`) so the global provider + ContextManager are registered before the DO runs.

### C. Plain Node / Express / Fastify / NestJS (long-running Node server)  →  `@heystack/otel/node`
Signals: `express`/`fastify`/`@nestjs/*`, or a plain Node entry with no edge runtime. Initialise as the VERY FIRST import in the entry file (before the framework), so auto-instrumentation can patch modules:
```ts
import { initHeystack } from "@heystack/otel/node";
initHeystack({ apiKey: process.env.HEYSTACK_API_KEY!, service: "my-app" });
// ...then the rest of your imports/app...
```
This bundles auto-instrumentations (HTTP, common libs) and registers a SIGTERM/SIGINT flush. Put `HEYSTACK_API_KEY` in `.env` (loaded before this runs). Pass `debug: true` to log export activity while verifying.

> Tip for entry-ordering in Node: if your build can't guarantee this is first, use `node --import` with a small `heystack.mjs` that calls `initHeystack`, or your framework's instrumentation hook.

## Step 3 — Set the environment variable

- Local: `.env` / `.env.local` with `HEYSTACK_API_KEY=sk_live_…` (ensure `.env*` is gitignored).
- Cloudflare Workers: `wrangler secret put HEYSTACK_API_KEY`.
- Vercel/Netlify/etc.: add `HEYSTACK_API_KEY` in the platform's env settings (and to the right environments).

## Step 4 — Verify

Run the app and make one request. Within a few seconds, traces appear in the Heystack console under the app whose `service` name you set. If nothing shows:
- Confirm `HEYSTACK_API_KEY` is actually set in the running environment.
- For `@heystack/otel/node`, pass `debug: true` to see OTel export logs.
- Confirm the `service` here matches the app's service name in the console.
- Confirm `@heystack/otel` is `>=0.3.2` (older versions silently send nothing on OpenNext/workerd, drop traces on the OpenNext path with no manual flush hook, or — pre-0.3.2 — can loop the ingest POST because self-trace suppression was a no-op).
- On Cloudflare Workers/OpenNext, confirm `nodejs_compat` is in `compatibility_flags` (required by `>=0.3.2` for the context manager / suppression).
- Heavy Node startup or overhead? Pass a slimmer `instrumentations: [...]` array to `initHeystack` instead of the default `getNodeAutoInstrumentations()` (which patches ~40 libs).
- For a Next app on OpenNext/Cloudflare, the `/next` entry handles workerd automatically — no separate Workers wiring needed. If spans still don't show, call `flushHeystack()` from a response hook for guaranteed delivery.

## Runtime decision table (quick reference)

| Where the code runs | Entry to import | Key via |
|---|---|---|
| Next.js — any target (Vercel/Node **or** Cloudflare/OpenNext) | `@heystack/otel/next` (`registerHeystack`, auto-detects workerd) | `.env.local` / platform env / `wrangler secret` |
| Standalone Cloudflare Worker (`export default { fetch }`, not Next) | `@heystack/otel/workers` (`instrument`, outermost wrapper) | `wrangler secret` |
| Long-running Node server | `@heystack/otel/node` (`initHeystack`) | `.env` / platform env |
| Just need the export URL/headers | `@heystack/otel` (`buildExporterConfig`) | n/a (pure) |
