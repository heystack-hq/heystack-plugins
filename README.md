# Heystack plugins (Claude Code)

Claude Code plugin marketplace for [Heystack](https://heystack.dev) — observability + security for AI apps.

## Install

```
/plugin marketplace add heystack-hq/heystack-plugins
/plugin install heystack-setup@heystack
```

Then tell your agent to "set up Heystack" — it detects the runtime and wires the matching integration. Android uses direct OTLP/HTTP logs and a Mobile (Android) key; JavaScript runtimes use the correct `@heystack/otel` entry. For Cloudflare Workers it configures native trace/log destinations, native business spans, Agents/Tail Worker observability, and the optional Workers Analytics metrics connector.

## Plugins

- **heystack-setup** — runtime-aware setup for Android, Workers, Agents, Next.js, Node, and browser telemetry; prevents incorrect SDK installs and duplicate Cloudflare trace export.
