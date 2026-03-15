# Plan: /add-graphiti skill for NanoClaw

## Context

- Issue #1356 on qwibitai/nanoclaw identifies scaling limitations with NanoClaw's current file-based memory system (no relevance filtering, no search, stale accumulation, token cost grows linearly)
- Graphiti is a high-performance, temporally-aware knowledge graph framework by Zep that solves these problems: highly relevant semantic search, cross-session sharing, entity extraction, fact relationships with both created_at timestamps and valid_at timestamps, allowing for the invalidation of facts over time
- Graphiti provides two Docker Compose options for graph databases: FalkorDB (single combined container with Redis + MCP) or Neo4j (two containers)

## Our Implementation

Two upstream file changes:

1. **`container/agent-runner/src/index.ts`** — adds `mcp__graphiti__*` to allowedTools + graphiti HTTP MCP server config
2. **`groups/global/CLAUDE.md`** — adds Graphiti memory instructions (recall, save, remove)

Hardcoded to `http://10.0.0.131:8000/mcp` (Umbrel LAN IP). No env var, no Docker management. Uses shared `group_id: "brent"` so Bee and Brent's Claude Code instances share the same knowledge graph.

## Graphiti supported backends

### LLM providers
OpenAI (default: gpt-4.1-mini), Azure OpenAI, Anthropic, Gemini, Groq

### Embedding providers
OpenAI (default: text-embedding-3-small), Azure OpenAI, Gemini, Voyage AI

### Database backends

| Backend | Containers | Notes |
|---------|-----------|-------|
| **Neo4j** (recommended) | 2 (Neo4j + MCP server) | Battle-tested, what we run on Umbrel. Compose: `docker-compose-neo4j.yml` |
| **FalkorDB** | 1 (combined: Redis + FalkorDB + MCP server) | Single container via `zepai/knowledge-graph-mcp`. Simpler deploy, less proven at scale |

Default to **Neo4j** — it's what we know works and is more widely documented.

## Design

### Two deployment modes

**Mode A: Local (default)** — Graphiti runs as a Docker Compose stack alongside NanoClaw
- Uses Graphiti's official `docker-compose-neo4j.yml` (Neo4j + MCP server)
- Managed via docker compose in a `graphiti/` directory within the NanoClaw project
- Agent containers reach it via `host-gateway` (same pattern as the credential proxy)
- SKILL.md walks user through: `docker compose up -d`, set env vars, rebuild container

**Mode B: External** — Graphiti runs on a separate host (Umbrel, server, cloud)
- User provides `GRAPHITI_URL` (e.g. `http://192.168.1.50:8000/mcp`)
- No Docker management needed on the NanoClaw host
- Same agent-runner integration, just a different URL

### Env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `GRAPHITI_URL` | (none — skill is disabled when unset) | Graphiti MCP endpoint URL |
| `OPENAI_API_KEY` | (required for Graphiti) | Used by Graphiti for embeddings + entity extraction |

`group_id` uses Graphiti's default. Users who want per-agent or per-group isolation can configure it via Graphiti's `GROUP_ID` env var on the Graphiti server side.

### Code changes (on skill branch)

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Add `mcp__graphiti__*` to allowedTools; add graphiti MCP server conditionally when `GRAPHITI_URL` env var is present |
| `groups/global/CLAUDE.md` | Add Graphiti memory instructions (recall, save, remove) to Memory section |
| `src/config.ts` | Read `GRAPHITI_URL` from env |
| `src/container-runner.ts` | Pass `GRAPHITI_URL` to container env |
| `graphiti/docker-compose.yml` | Local Graphiti stack (Neo4j + MCP server) for Mode A |
| `.env.example` | Add `GRAPHITI_URL`, `OPENAI_API_KEY` |

### Container networking

NanoClaw agent containers already use `host-gateway` to reach the credential proxy on the host. If Graphiti runs locally (Mode A), the agent container reaches it the same way: `http://host-gateway:8000/mcp`. If external (Mode B), the URL just needs to be routable from inside the container (which it is — containers have internet access).

### SKILL.md phases

1. **Pre-flight** — check Docker, ask Mode A or B
2. **Apply code changes** — merge skill branch from `nanoclaw-graphiti` repo
3. **Start Graphiti** (Mode A only) — collect `OPENAI_API_KEY`, create `.env` for Graphiti, `docker compose up -d`
4. **Configure** — set `GRAPHITI_URL` in NanoClaw `.env`, rebuild container
5. **Verify** — send a message, check agent uses `add_memory` and `search_memory_facts`

### What this addresses from #1356

| Problem | How Graphiti solves it |
|---------|----------------------|
| No relevance filtering | Semantic search via `search_memory_facts` — only relevant facts loaded |
| Stale memory accumulation | Temporal metadata + `expired_at` field auto-invalidates old facts |
| No cross-session sharing | Knowledge graph persists across all sessions and groups |
| No search mechanism | `search_memory_facts`, `search_nodes` — natural language queries |
| Token cost grows linearly | Only search results enter context, not entire memory store |

## Tasks

- [ ] 1. Create `nanoclaw-graphiti` fork repo (like nanoclaw-signal)
- [ ] 2. Create skill branch with code changes (agent-runner, config, container-runner, CLAUDE.md)
- [ ] 3. Make `GRAPHITI_URL` configurable (replace hardcoded IP), conditional (disabled when unset)
- [ ] 4. Add `graphiti/docker-compose.yml` for local mode (based on Graphiti's official Neo4j compose)
- [ ] 5. Write SKILL.md with both Mode A and Mode B paths
- [ ] 6. Test fresh install (Mode A: local Docker)
- [ ] 7. Test existing install (Mode B: external, like our Umbrel setup)
- [ ] 8. File a GitHub issue proposing Graphiti as a solution to #1356
- [ ] 9. Open PR on qwibitai/nanoclaw referencing the issue

## Review
_(to be filled after completion)_
