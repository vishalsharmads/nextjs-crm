# AI agents and modules

There are two MCP servers, for two different kinds of agent.

| Server                       | For                                                                       | Acts on                                | Start                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Developer MCP (`module-dev`) | AI coding agents working in a checkout of this repository                 | Files in the working tree              | `npm run mcp:dev`                                                                         |
| Product MCP                  | AI clients of a running workspace (people's data, with their permissions) | One instance's database, through tools | `/api/v1/mcp`, or `npm run mcp` as a stdio bridge; see [integrations.md](integrations.md) |

## AI coding agents (developer MCP)

The developer MCP server helps a coding agent build modules that follow the rules. It never touches a database or a running instance, and it is not part of the production bundle (`apps/api/src/cli/dev-mcp.ts`).

**Connect.** `.mcp.json` at the repository root registers the server for agents that read it. For other clients, configure a stdio server:

```json
{ "command": "npx", "args": ["tsx", "apps/api/src/cli/dev-mcp.ts"], "cwd": "<checkout>" }
```

Use `npx tsx`, not `npm run`, so npm's banner never reaches stdout.

**Tools.**

| Tool                   | Does                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module_list`          | Modules in the checkout: version, category, settings, and whether `installed.ts` lists them                                                                         |
| `module_scaffold`      | `module:new`: a record-type module (`kind: "record"`) or an integration (`kind: "integration"`), registered in `installed.ts`                                       |
| `module_validate`      | `module:check` plus registration: manifest, help article, imports only from `@app/api/module-api`, `m_<key>_*` tables, no `child_process` or `eval`, no brand names |
| `module_api_reference` | The `module-api.ts` contract with its doc comments, and the event names                                                                                             |
| `brand_check`          | Brand deny-list hits in one module or all                                                                                                                           |
| `docs_read`            | The module guide, integration guide, integrations reference or AGENTS.md (also served as `docs://` resources)                                                       |
| `module_add`           | `module:add`: a catalog module at its pinned commit, refused if the tag moved or the module fails the checks                                                        |

**Rules.** The server's instructions give agents the module rules, and `module_validate` enforces most of them. Generated code is ordinary code in the working tree: it goes through the same review, typecheck, lint, tests and release as code a person wrote.

**A typical session.**

1. `docs_read("module-authoring")`, or `docs_read("integration-authoring")` for an integration.
2. `module_scaffold`, then `npm install`.
3. Edit the generated files.
4. `module_validate` until it returns no problems.
5. `npm run typecheck`, `npm run lint` and the module's tests.
6. A person reviews and commits.

## Generating modules inside a running workspace

Not built. An AI client asking a running workspace to generate and install a module means running new code on the server. That needs the signed, run-time module upload designed in [plan/phase-8.md](plan/phase-8.md) (8d) to exist first; generation is designed there as 8f.

Until then, an AI client that needs a new kind of record uses admin-defined objects (Settings → Objects). They need no code.
