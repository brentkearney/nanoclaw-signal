# Proposal: Add Graphiti knowledge graph as agent memory skill

Relates to #1356

## Problem

NanoClaw's current file-based memory system loads all memories into context regardless of relevance, accumulates stale entries without cleanup, has no search mechanism, and token costs grow linearly with each new memory. As agents run more conversations, the memory files become a bottleneck.

## Proposal

Add an `/add-graphiti` skill that gives NanoClaw agents a persistent, searchable knowledge graph via [Graphiti](https://github.com/getzep/graphiti) by Zep.

### What is Graphiti?

Graphiti is a framework for building and querying temporal context graphs for AI agents ([paper](https://arxiv.org/abs/2501.13956)). It combines a **vector database** (semantic embeddings) with a **graph database** (Neo4j) to create a hybrid retrieval system that uses semantic similarity, keyword search (BM25), and graph traversal — without relying on LLM summarization at query time.

Unlike traditional RAG which relies on batch processing and static data, Graphiti continuously integrates new information into a coherent, queryable graph with incremental updates — no full recomputation needed.

- At the time of this writing, Graphiti has **over 24,000 stars** on Github
- Runs out-of-the-box using the project-supplied, and up-to-date [docker image](https://hub.docker.com/r/zepai/knowledge-graph-mcp)
- Project also supplies a [docker-compose file](https://github.com/getzep/graphiti/blob/main/mcp_server/docker/docker-compose-neo4j.yml) for easy integration with the popular [Neo4j Community Edition](https://github.com/neo4j/neo4j) graph database
- Comes with a very capable [MCP Server](https://github.com/getzep/graphiti/tree/main/mcp_server), with HTTP transport for easy access by all agents
- Supports multiple LLM Providers: OpenAI, Anthropic, Gemini, Groq, and Azure OpenAI -- there are open PRs to add local LLM support.
- Battle-tested and stable, it is the software behind the commercial [Zep AI memory service](https://www.getzep.com)

### Knowledge graph structure

A Graphiti context graph has four components:

- **Entities (nodes)** — people, projects, tools, concepts, with evolving summaries that update as new information arrives
- **Facts (edges)** — relationships between entities with temporal validity windows (e.g., "Project X uses PostgreSQL" valid from March 2026, superseded in June 2026). When information changes, old facts are invalidated — not deleted — preserving full history
- **Episodes (provenance)** — the raw content that was ingested (text, messages, JSON). Every derived entity and fact traces back to its source episode
- **Custom entity types** — configurable ontology (Preference, Organization, Event, Topic, etc.)

When an agent saves an episode, Graphiti automatically extracts entities and relationships with timestamps. Agents can then search for relevant facts by topic instead of loading everything into context.

## How Graphiti addresses concerns of #1356

| Problem | How Graphiti solves it |
|---------|----------------------|
| All memories load into context | Semantic search returns only relevant facts |
| Stale memories accumulate | Temporal metadata with `expired_at` auto-invalidates old facts |
| No cross-session sharing | Knowledge graph persists across all sessions |
| No search mechanism | Natural language queries via `search_memory_facts` and `search_nodes` |
| Token costs grow linearly | Only search results enter context, not entire memory store |

👉 [Comparison of Graphiti with mem0 a.k.a. OpenMemory](https://www.getzep.com/mem0-alternative/)

