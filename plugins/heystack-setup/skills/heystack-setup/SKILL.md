---
name: heystack-setup
description: >-
  Use when adding Heystack observability to a project, or when the user mentions
  @heystack/otel, "set up Heystack", "add observability/tracing", Android OTLP
  logs, or an ingest key like sk_live_… or hs_android_…. Detects Android,
  Next.js, Cloudflare Workers/OpenNext, Node/Express/Fastify, edge, and browser
  runtimes; then wires the matching SDK or direct OTLP/HTTP pattern and
  credential class. Android does not use the JavaScript SDK, and the wrong
  JavaScript runtime entry is a production no-op.
---

<!-- MAINTAINER: this file is mirrored to heystack-hq/heystack-plugins (the
     published plugin repo). Re-sync that repo after changes here.
     0.13.0: Cloudflare-native trace routing, async-safe custom spans, queue/cron,
     Agents observability + Tail Worker adapters; direct OTLP is fallback-only.
     0.10.0: release/commit attribution — optional version (→ service.version) +
     build (→ service.build, commit SHA) options on every runtime entry; powers
     release health + suspect release/commit in the console. Node also reads
     HEYSTACK_SERVICE_VERSION / OTEL_SERVICE_VERSION / HEYSTACK_SERVICE_BUILD env.
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

Heystack is observability + security for AI apps. JavaScript runtimes use the runtime-aware `@heystack/otel` package. Android apps send standard OTLP/HTTP JSON directly to `https://ingest.heystack.dev/v1/logs`; there is no Heystack Android package to install. **Using the wrong JavaScript entry breaks the app or silently sends nothing**, so detect the runtime first.

> **Requires `@heystack/otel` `>=0.13.0` (prefer latest).** Pin it. 0.13 makes Cloudflare's native invocation/platform trace authoritative, adds native business spans, queue/cron coverage, and the Agents/Tail Worker adapters. Direct Workers OTLP remains an explicit compatibility fallback.

## Step 0 — Get the ingest key (never hardcode it)

The user creates an app in the Heystack console (https://console.heystack.dev). Choose the credential for the runtime:

- Node, Next.js, direct Workers, and server-side SDKs use a **server key** (`sk_live_…`). Read it from `HEYSTACK_API_KEY`; never embed it in client code.
- Android uses a **Mobile (Android) key** (`hs_android_…`). Mint it from the app's **Settings** tab. It is public and ingest-only, so it is safe in a distributed app but cannot perform privileged operations. Keep the raw value out of source history and inject it from the release CI secret store.
- Cloudflare native mode stores its bearer token only in the destination header in the Cloudflare dashboard.

Every raw key is shown once. **Never paste one into committed source.**

## Step 1 — Detect Android before installing anything

Look for `settings.gradle`, `settings.gradle.kts`, `build.gradle`, or `build.gradle.kts` with the Android application/library plugin. If this is an Android app, **do not install `@heystack/otel`**. Skip the JavaScript package-manager step and apply runtime pattern E below.

For JavaScript runtimes, check the lockfile in the project root:

Install with the `>=0.13.0` pin:

| Lockfile | Manager | Install command |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm add "@heystack/otel@>=0.13.0"` |
| `yarn.lock` | yarn | `yarn add "@heystack/otel@>=0.13.0"` |
| `bun.lockb` | bun | `bun add "@heystack/otel@>=0.13.0"` |
| `package-lock.json` (or none) | npm | `npm install "@heystack/otel@>=0.13.0"` |

## Step 2 — Detect the runtime, then apply the matching pattern

Inspect the project and its config files. **Match in this order**: Android first; then Next (which covers its own Cloudflare/OpenNext case); then standalone Workers, Node, and browser.

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

Use Cloudflare-native OpenTelemetry as the authoritative trace/log plane. The SDK enriches that same native tree; it must not run a second exporter.

#### 1. Create separate native destinations

In Cloudflare **Workers Observability → Add destination**, create:

- `heystack-traces` (type **Traces**) → `https://ingest.heystack.dev/v1/traces`
- `heystack-logs` (type **Logs**) → `https://ingest.heystack.dev/v1/logs`
- On both: `Authorization: Bearer <HEYSTACK_INGEST_KEY>`

Then update `wrangler.toml`:

```toml
[observability.traces]
enabled = true
destinations = ["heystack-traces"]
head_sampling_rate = 1
persist = false

[observability.logs]
enabled = true
destinations = ["heystack-logs"]
head_sampling_rate = 1
persist = false
```

Destination names must match the dashboard. `persist = false` exports without also buying Cloudflare dashboard storage. Native export currently requires a Workers Paid or contract plan and exports traces/logs, not metrics.

#### 2. Install the native-first SDK for business context

```bash
npm install "@heystack/otel@>=0.13.0"
```

```ts
import { instrument, withCloudflareSpan } from "@heystack/otel/workers";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return withCloudflareSpan(ctx, "order.load", { "order.id": "o1" }, async () => {
      return Response.json(await env.DB.prepare("SELECT 1").first());
    });
  },
};

export default instrument(worker, {
  service: "my-worker",
  nativeTracing: "auto", // default
  getUser: (request) => ({
    id: request.headers.get("x-user-id") ?? undefined,
    session: request.headers.get("x-session-id") ?? undefined,
  }),
  version: "1.4.2", // optional
  build: "<git-sha>", // optional
});
```

In native mode:

- do **not** add `HEYSTACK_API_KEY` to the Worker; the destination owns authentication;
- do **not** enable `instrumentBindings`; Cloudflare automatically instruments supported `fetch`, KV, D1, and other platform operations;
- no `nodejs_compat` flag is required by Heystack;
- queue and scheduled handlers are wrapped in native spans;
- use `withCloudflareSpan(ctx, ...)` for async-safe custom spans after arbitrary `await` boundaries;
- use `withSpan(...)` only when an active native/OTel context is already available.

Set `nativeTracing: "direct"` only on a runtime where `ctx.tracing`/native export is unavailable. Direct mode requires `wrangler secret put HEYSTACK_API_KEY`, `nodejs_compat`, and may use `instrumentBindings`, sampling, and AI enrichment. Never combine direct mode with a native trace destination; that duplicates spans.

#### 3. Cloudflare Agents SDK

For Agents, retain every SDK lifecycle event as a trace-correlated native log:

```ts
import { Agent } from "agents";
import { createCloudflareAgentsObservability } from "@heystack/otel/workers/agents";

const observability = createCloudflareAgentsObservability();
export class SupportAgent extends Agent<Env> {
  override observability = observability;
}
```

The adapter covers RPC, state, messages/tools, chat/recovery, fibers, scheduling/queues, lifecycle, workflows, MCP, and email. It redacts token/auth/cookie/secret and prompt/completion/content/message fields. In production, attach a Tail Worker with `createCloudflareAgentsTailHandler()` and enable `heystack-logs` on that Tail Worker so diagnostics-channel events are retained off the Agent hot path.

#### 4. Worker metrics

Cloudflare does not export metrics over OTLP. In Heystack app **Settings → Cloudflare Workers Analytics**, connect an API token with only **Account Analytics Read**, plus the account ID and optional script name. The connector imports requests, errors, subrequests, and CPU p50/p99 every five minutes. Heystack also derives RED metrics from trace spans.

#### 5. Validate all execution models

Exercise fetch, outbound fetch/bindings, queue, cron, Durable Objects, Workflows, and Agents. Confirm native platform spans and Heystack business spans share one trace; logs correlate; failures carry Cloudflare outcome/CPU/wall-time/colo metadata; and the native destination status reports recent delivery.

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
Signals: a client-rendered web app — a Vite/CRA SPA, or the **client** of a Next/Remix/etc. app — where you want **session replay**, **browser error collection**, plus client→backend trace correlation. This is **in addition to** any server-side entry above (A/B/C trace the backend; `/web` records the browser). Call `instrumentWeb` once, early in the client entry (e.g. `main.tsx`):
```ts
import { instrumentWeb } from "@heystack/otel/web";

await instrumentWeb({
  apiKey: import.meta.env.VITE_HEYSTACK_API_KEY, // same ingest key; exposed to the client build
  service: "my-web-app",
});
```
`instrumentWeb` records session replay and injects a W3C `traceparent` on outgoing `fetch` calls so replays correlate with backend traces. It returns a `stop()` function and is a **no-op on the server** (SSR-safe). The rrweb recorder **ships inside `@heystack/otel`** (nothing else to install) and uploads **cross-origin with no CORS setup**. **Sampling and masking are controlled from the console** — tell the user to enable replay under **Settings → Session replay** for the app (nothing records until it's enabled there). Masking is strict by default (all text inputs/passwords masked); fine-tune in the DOM with `data-hs-mask` (mask an element), `data-hs-block` (block a region), `data-hs-unmask` (reveal a trusted element). The optional `sampleRate` is only a local override.

**Browser error collection (on by default):** `instrumentWeb` also captures uncaught errors (`window.onerror` + `unhandledrejection`) and `console.error` as logs — they appear in the app's **Logs** tab, stamped with the page URL and `session_id` (so each error links to its session replay and, if tracing is on, its trace). Options: `errors: false` to disable, `captureConsole: 'warn' | 'error' | false` (default `'error'`; `'warn'` also captures `console.warn`). Also pass `version` / `build` (release + commit) so a browser regression is attributed to the release that introduced it. Console capture is rate-capped and never traces its own upload (no self-export loop).

**In-app bug reports (`reportBug`):** the `/web` entry also exports `reportBug({ message, email?, context? })` — a headless API (no widget; the app builds the button) that lets a user file a bug from inside the app. It auto-attaches the URL, replay `session_id`, active `trace_id`, `version` / `build`, and the last few captured browser errors, and the report shows up in the console **Bugs** tab already linked to the session replay and trace. Call it any time after `instrumentWeb()` (it throws before init or on an empty message; network failures are swallowed). Wire it to whatever UI you like:

```ts
import { reportBug } from "@heystack/otel/web";
await reportBug({ message: userText, email: currentUser?.email, context: { screen: "checkout" } });
```

**Browser distributed tracing (optional):** pass `tracing: true` (and a `traceSampleRate`, 0–1) to also emit a real CLIENT span per outbound `fetch` and propagate W3C context — so a browser→API call shows as ONE connected trace and a `web → api` service-map edge (view the map as **All apps** for the org-wide topology). Off by default (adds backend span volume), head-sampled, and never traces its own upload (no self-export loop). Independent of replay.

**Framework placement — it MUST run in the browser:**
- **Vite / CRA** — call it in the client entry (`main.tsx`), as above.
- **Next.js (App Router)** — a server component can't call it. Put it in a `"use client"` component that runs `instrumentWeb()` from a `useEffect`, then mount that once in `app/layout.tsx`, keyed on `process.env.NEXT_PUBLIC_HEYSTACK_API_KEY`:
```tsx
"use client";
import { useEffect } from "react";
import { instrumentWeb } from "@heystack/otel/web";
export function HeystackReplay() {
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_HEYSTACK_API_KEY;
    if (!apiKey) return;
    let stop: (() => void) | undefined, cancelled = false;
    instrumentWeb({ apiKey, service: "my-web-app" }).then((s) => (cancelled ? s() : (stop = s))).catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, []);
  return null;
}
```

> Note: the browser bundle includes the ingest key, so a `/web` key is necessarily public — that's expected for client telemetry (use a dedicated, rotatable key). Sampling/masking are enforced server-side from the console config.

### E. Android app → direct OTLP/HTTP logs (no `@heystack/otel` package)

Signals: an Android Gradle plugin plus `AndroidManifest.xml`, Kotlin/Java Android sources, or an Android application module. Heystack currently accepts Android telemetry as standard OTLP/HTTP logs. Do not add the JavaScript SDK or use a server key.

1. Mint a **Mobile (Android) key** (`hs_android_…`) in the app's Heystack **Settings** tab.
2. Keep the raw value in the release CI secret store. Inject it into a `BuildConfig` field through a Gradle property; keep the default empty so local/debug builds can remain inert:

```kotlin
// app/build.gradle.kts
val heystackIngestKey = (project.findProperty("heystackIngestKey") as String?) ?: ""
android.defaultConfig {
    buildConfigField("String", "HEYSTACK_INGEST_KEY", "\"$heystackIngestKey\"")
}
```

Build release artifacts with the secret supplied by CI, for example:

```bash
./gradlew assembleRelease -PheystackIngestKey="$HEYSTACK_INGEST_KEY_ANDROID"
```

The key is recoverable from the distributed app; CI injection keeps it out of source history but does not make it secret. The `hs_android_…` class is intentionally ingest-only and rotatable.

3. POST standard OTLP Logs JSON to `https://ingest.heystack.dev/v1/logs` with:

```text
Authorization: Bearer hs_android_…
Content-Type: application/json
```

Use the project's existing HTTP client and JSON serializer. Each request must contain `resourceLogs`; include `service.name` and, when available, `service.version` and `deployment.environment` as resource attributes. Model each product event as a log record with `event.name`. OTLP `timeUnixNano` and integer values are JSON strings. Send off the UI thread, bound to an application-owned lifecycle scope, and swallow/report transport failures without breaking the user flow.

4. Preserve the app's consent boundary. Do not capture email, names, message text, auth tokens, podcast/search content, or other user content. Use an opaque user ID only when the product's approved analytics policy allows it.

Do not use the Android key for dSYM upload or other privileged APIs; those require `sk_live_…`. Heystack does not currently provide Android crash-symbol upload through this path.

### Attribute telemetry to a release/commit (recommended, JavaScript runtimes)

Set two optional options so the console can show **release health** and pinpoint the **suspect release / suspect commit** behind a regression — they work on `/node`, `/next`, and `/workers`:

```ts
initHeystack({
  apiKey: process.env.HEYSTACK_API_KEY,
  service: "my-app",
  version: process.env.APP_VERSION, // → service.version (a release id: "1.4.2", a git tag, …)
  build: process.env.GIT_SHA,       // → service.build   (the commit SHA of this deploy)
});
```

- `version` → the `service.version` resource attribute — groups telemetry by release.
- `build` → the `service.build` resource attribute — the commit SHA; deep-links to the commit when a repo URL is set for the app in the console.

Wire them from the build/deploy environment (e.g. `build: process.env.GIT_SHA`, with `GIT_SHA=$(git rev-parse HEAD)` in CI). For **Next.js** pass them to `registerHeystack({ service, version, build })`; for **Workers** pass them in the `instrument()` config. On **Node** you can instead set env vars: `HEYSTACK_SERVICE_VERSION` (or `OTEL_SERVICE_VERSION`) and `HEYSTACK_SERVICE_BUILD`. Both options are optional — omit them if the app has no release/commit concept.

## Step 3 — Set the environment variable

- Local: `.env` / `.env.local` with `HEYSTACK_API_KEY=sk_live_…` (ensure `.env*` is gitignored).
- Cloudflare Workers native export: store the bearer token in each Cloudflare OTel destination; there is no Worker runtime secret. Direct compatibility mode only: `wrangler secret put HEYSTACK_API_KEY`.
- Vercel/Netlify/etc.: add `HEYSTACK_API_KEY` in the platform's env settings (and to the right environments).
- Android: store `HEYSTACK_INGEST_KEY_ANDROID=hs_android_…` in the release CI secret store and pass it to the Gradle property used by the app. Do not add it to `gradle.properties`, source, logs, or pull-request output.

## Step 4 — Verify

Run the app and make one request. Within a few seconds, traces appear in the Heystack console under the app whose `service` name you set. If nothing shows:
- Confirm `HEYSTACK_API_KEY` is actually set in the running environment.
- For `@heystack/otel/node`, pass `debug: true` to see OTel export logs.
- Confirm the `service` here matches the app's service name in the console.
- Confirm `@heystack/otel` is `>=0.7.0` (0.7.0 adds remote sampling; 0.6.0 adds head sampling; 0.5.0 adds identity enrichment, binding tracing, outbound-fetch spans, and manual span helpers; older versions silently send nothing on OpenNext/workerd or — pre-0.3.2 — can loop the ingest POST).
- On standalone Cloudflare Workers, confirm `ctx.tracing` is available and both native destinations report successful delivery. `nodejs_compat` is only required by direct compatibility mode, not the native path.
- Heavy Node startup or overhead? Pass a slimmer `instrumentations: [...]` array to `initHeystack` instead of the default `getNodeAutoInstrumentations()` (which patches ~40 libs).
- For a Next app on OpenNext/Cloudflare, the `/next` entry handles workerd automatically — no separate Workers wiring needed. If spans still don't show, call `flushHeystack()` from a response hook for guaranteed delivery.
- On Android, make one consent-approved test event from a release-like build. Confirm the request returns success, then filter the app's **Logs** tab by `service.name` and `event.name`. A debug build with an intentionally empty key should stay inert.

## Runtime decision table (quick reference)

| Where the code runs | Entry to import | Key via |
|---|---|---|
| Next.js — any target (Vercel/Node **or** Cloudflare/OpenNext) | `@heystack/otel/next` (`registerHeystack`, auto-detects workerd) | `.env.local` / platform env / `wrangler secret` |
| Standalone Cloudflare Worker — complete native platform tree | CF native OTel trace/log destinations + `[observability.traces]` and `[observability.logs]` in `wrangler.toml` | Bearer token set in each CF dashboard destination |
| Standalone Cloudflare Worker — custom business spans in that native tree | `@heystack/otel/workers` (`instrument` + `withCloudflareSpan`) with native export still authoritative | Same CF dashboard destinations; no runtime key |
| Standalone Cloudflare Worker — runtime lacks `ctx.tracing` | `@heystack/otel/workers` with `nativeTracing: "direct"` (compatibility fallback) | `wrangler secret` |
| Long-running Node server | `@heystack/otel/node` (`initHeystack`) | `.env` / platform env |
| Browser / web frontend (session replay) | `@heystack/otel/web` (`instrumentWeb`, in the client entry) | public client env var; enable replay in **Settings → Session replay** |
| Android app | Direct OTLP/HTTP JSON to `/v1/logs`; no Heystack package | `hs_android_…` injected from release CI into the app build |
| Just need the export URL/headers | `@heystack/otel` (`buildExporterConfig`) | n/a (pure) |
