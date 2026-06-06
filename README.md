# Heystack plugins (Claude Code)

Claude Code plugin marketplace for [Heystack](https://heystack.dev) — observability + security for AI apps.

## Install

```
/plugin marketplace add heystack-hq/heystack-plugins
/plugin install heystack-setup@heystack
```

Then tell your agent to "set up Heystack" — it detects your framework (Cloudflare Workers, Next.js, Node) and package manager and wires `@heystack/otel` correctly for that runtime.

## Plugins

- **heystack-setup** — runtime-aware `@heystack/otel` setup; chooses the right entry (`/workers`, `/next`, `/node`) so it works in production, not just locally.
