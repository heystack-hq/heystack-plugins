# Heystack plugins (Claude Code)

Claude Code plugin marketplace for [Heystack](https://heystack.dev) — observability + security for AI apps.

## Install

```
/plugin marketplace add heystack-hq/heystack-plugins
/plugin install heystack-setup@heystack
```

Then tell your agent to "set up Heystack" — it detects your framework and package manager and wires `@heystack/otel` correctly. For Cloudflare Workers it configures native trace/log destinations, native business spans, Agents/Tail Worker observability, and the optional Workers Analytics metrics connector.

## Plugins

- **heystack-setup** — runtime-aware `@heystack/otel` setup; chooses `/workers`, `/workers/agents`, `/next`, `/node`, or `/web` and prevents duplicate Cloudflare trace export.
