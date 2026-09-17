# Heystack plugins

Plugins for [Heystack](https://heystack.dev) — observability + security for AI apps — so your coding agent can **set up** Heystack, **investigate** incidents, and **manage** your workspace from your editor.

## Install (Claude Code)

```
/plugin marketplace add heystack-hq/heystack-plugins
/plugin install heystack@heystack
```

Then run `/mcp` to sign in with Heystack and pick your organization. Try: *"list my Heystack apps"*, *"why is /checkout failing since the last deploy?"*, or *"set up Heystack in this project and verify it's receiving data"*.

## What you get

**`heystack`** (recommended) — the all-in-one plugin:

- **Hosted MCP server** at `https://mcp.heystack.dev/mcp` (connected with `?toolsets=all`): app health, search traces & logs in plain English, open and explain traces, session stories and replays, issues and crashes with the suspect release, gen-AI usage & cost, a one-call incident dossier (`heystack_investigate`); plus apps, ingest keys, sampling/replay config, alert rules, team and tokens. Sign in with Heystack (OAuth) — no keys to paste. Full reference: https://heystack.dev/docs/mcp
- **`heystack-setup` skill** — detects the runtime (Next.js, Cloudflare Workers/Agents, Node, browser, Android) and wires the correct `@heystack/otel` entry or OTLP path; with the MCP server it creates the app and key itself and verifies data arrives with `heystack_verify_setup`.
- **`heystack-investigate` skill** — the investigation loop: overview → dossier → traces/sessions → fix in code → verify; when to change issue status or create alerts; never destructive without your confirmation.

**`heystack-setup`** — the setup skill on its own (no MCP server), kept for existing installs: `/plugin install heystack-setup@heystack`.

## Other agents

- Cursor / VS Code / Codex / Gemini CLI / Claude.ai connect to the same MCP URL — see https://heystack.dev/docs/mcp for one-click links and commands.
- The skills are plain [Agent Skills](https://agentskills.io) files and are also served raw at https://heystack.dev/heystack-setup.md and https://heystack.dev/heystack-investigate.md. The root `plugin.json` / `mcp.json` / `skills/` follow the cross-vendor [Agent Plugins](https://agent-plugins.org) layout.
- Every docs page is available as Markdown: https://heystack.dev/llms.txt

## Layout

```
.claude-plugin/marketplace.json           # Claude Code marketplace (plugins: heystack, heystack-setup)
plugins/heystack/                         # all-in-one: .mcp.json + skills/
plugins/heystack-setup/                   # skill-only (legacy)
plugin.json · mcp.json · skills/          # Agent Plugins (cross-vendor) layout of the `heystack` plugin
```

Source of truth for the skills is the [heystack monorepo](https://github.com/heystack-hq/heystack) (`packages/setup-skill`, `packages/investigate-skill`); this repo is a mirror.
