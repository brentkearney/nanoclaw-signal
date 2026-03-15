## Proposed Graphiti Skill

The skill will run Graphiti locally via Docker Compose (Neo4j + Graphiti MCP server). NanoClaw's agent containers connect to it over HTTP MCP — the same `host-gateway` pattern already used by NanoClaw's Docker networking.

### What the agent gets

- `search_memory_facts` — find relationships and facts by topic
- `search_nodes` — find entities and their summaries
- `add_memory` — save episodes (text, JSON, or messages)
- `get_episodes` — retrieve recent saved content
- `delete_episode`, `delete_entity_edge` — remove outdated info

### What changes in the codebase

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Add `mcp__graphiti__*` to allowedTools; add Graphiti HTTP MCP server (conditional on `GRAPHITI_URL`) |
| `groups/global/CLAUDE.md` | Add memory instructions: when/how to recall and save |
| `src/config.ts` | Read `GRAPHITI_URL` from env |
| `src/container-runner.ts` | Pass `GRAPHITI_URL` to container env |
| `graphiti/docker-compose.yml` | Neo4j + Graphiti MCP server stack |
| `.env.example` | Add `GRAPHITI_URL`, `OPENAI_API_KEY` |

### Requirements

- Docker (already required for NanoClaw)
- An OpenAI or other LLM provider API key for embeddings and entity extraction

Graphiti supports LLM/embedding providers:
- **LLM:** OpenAI (default), Azure OpenAI, Anthropic, Gemini, Groq
- **Embeddings:** OpenAI (default), Azure OpenAI, Gemini, Voyage AI

### Setup flow

1. Merge the skill branch (adds code changes + docker-compose file)
2. Set `OPENAI_API_KEY` in `graphiti/.env`
3. `docker compose -f graphiti/docker-compose.yml up -d`
4. Set `GRAPHITI_URL=http://host-gateway:8000/mcp` in NanoClaw's `.env`
5. Rebuild container, restart service

Entirely opt-in — when `GRAPHITI_URL` is not set, nothing changes.