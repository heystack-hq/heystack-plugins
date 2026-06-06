---
name: heystack-setup
description: Use when adding Heystack observability/tracing to a project, or when the user mentions @heystack/otel, "set up Heystack", "add observability/tracing", or an ingest key like sk_live_…. Detects the framework (Next.js, Cloudflare Workers/OpenNext, Node/Express/Fastify, edge) and package manager, installs @heystack/otel, and wires the correct runtime pattern with the ingest key as an environment variable. Critical: the wrong runtime pattern is a production no-op (the Node SDK cannot run on Workers/Edge), so detection matters.
---

# Setting up Heystack (@heystack/otel)

Heystack is observability + security for AI apps. `@heystack/otel` ships traces to the Heystack ingest endpoint (`https://ingest.heystack.dev`) over OTLP/JSON. The package is **runtime-aware** with separate entry points — **using the wrong one breaks the app or silently sends nothing**, so detect the runtime first.

## Step 0 — Get the ingest key (never hardcode it)

The user creates an app in the Heystack console (https://console.heystack.dev) and gets an `sk_live_…` key, shown once. The key is ALWAYS read from an environment variable named `HEYSTACK_API_KEY` — **never paste it into committed source**. If you don't have the key, ask the user to create an app in the console and paste the key, or set `HEYSTACK_API_KEY` themselves.

## Step 1 — Detect the package manager

Check the lockfile in the project root:

| Lockfile | Manager | Install command |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm add @heystack/otel` |
| `yarn.lock` | yarn | `yarn add @heystack/otel` |
| `bun.lockb` | bun | `bun add @heystack/otel` |
| `package-lock.json` (or none) | npm | `npm install @heystack/otel` |

## Step 2 — Detect the runtime, then apply the matching pattern

Inspect `package.json` dependencies + config files. **Match in this order** (Workers/edge checks first, because a Node-SDK pattern will throw on those runtimes):

### A. Cloudflare Workers / OpenNext / Vercel Edge  →  `@heystack/otel/workers`
Signals: a `wrangler.toml`/`wrangler.jsonc`, `@cloudflare/workers-types`, `@opennextjs/cloudflare`, `"main"` pointing at a Worker entry, or `export const runtime = "edge"`.
The Node SDK CANNOT run here. Use the native Workers wrapper around the default export:
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
Set the key as a Worker secret, not a file: `wrangler secret put HEYSTACK_API_KEY`. The wrapper auto-creates a server span per request and flushes via `ctx.waitUntil`.

### B. Next.js  →  `@heystack/otel/next`
Signals: `next` in dependencies. Next loads `instrumentation.ts` in BOTH the Node and Edge runtimes, so a top-level Node-SDK import would crash Edge. Use the runtime-guarded register helper. Create/extend `instrumentation.ts` (or `src/instrumentation.ts`) at the project root:
```ts
export async function register() {
  const { registerHeystack } = await import("@heystack/otel/next");
  await registerHeystack({ service: "my-app" }); // apiKey from process.env.HEYSTACK_API_KEY
}
```
It only initialises on the Node.js runtime and is a no-op on Edge. Put `HEYSTACK_API_KEY=sk_live_…` in `.env.local` (and the host's env for prod). For Next deployed to Cloudflare via OpenNext, ALSO consider the Workers path for the edge portions.

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
- Make sure you used the runtime pattern matching where the code actually RUNS in production (e.g. OpenNext/Workers deploys need the Workers path, not the Node path — `next dev` working locally does not prove prod works).

## Runtime decision table (quick reference)

| Where the code runs | Entry to import | Key via |
|---|---|---|
| Cloudflare Workers / OpenNext / Vercel Edge | `@heystack/otel/workers` (`instrument`) | `wrangler secret` / platform env |
| Next.js (instrumentation.ts) | `@heystack/otel/next` (`registerHeystack`) | `.env.local` / platform env |
| Long-running Node server | `@heystack/otel/node` (`initHeystack`) | `.env` / platform env |
| Just need the export URL/headers | `@heystack/otel` (`buildExporterConfig`) | n/a (pure) |
