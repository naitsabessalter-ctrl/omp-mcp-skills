# omp-mcp-skills

Use skills published by MCP servers from [Oh My Pi](https://github.com/can1357/oh-my-pi). The plugin lists skill metadata on demand and retrieves `SKILL.md` or supporting files only when requested. It does not install remote files as local skills.

## Install

```sh
omp plugin install github:naitsabessalter-ctrl/omp-mcp-skills
```

Start a new OMP session. Configure the MCP server in OMP as usual; the plugin has no separate credential store or MCP config. The server must declare both `resources` and `io.modelcontextprotocol/skills` and implement the [MCP Skills specification](https://modelcontextprotocol.io/extensions/skills/overview). Ordinary MCP tools, resources, and local `SKILL.md` files do not by themselves constitute support.

## Use

```text
/mcp-skills search
/mcp-skills search review
/mcp-skills load my-server skill://code-review/SKILL.md
```

Replace `my-server` and the URI with a result from your server. A direct user `load` command authorizes that skill; search and load do not invoke an LLM. The agent can instead call `mcp_skills_search`, `mcp_skills_load`, `mcp_skills_read`, and `mcp_skills_directory`. Loading by URI also works when `skills/list` omits the entry. Resource reads by themselves do not activate a skill.

**Approvals.** Model-initiated loads require interactive confirmation by default. With no UI the default is to refuse them. For explicitly trusted unattended automation, `OMP_MCP_SKILLS_APPROVALS=tool` accepts `approve: true` from a tool call instead of asking the user. This trusts the caller, including a model, and is **not** human approval. In that mode `mcp_skills_allow_exec` grants execution for the session. In UI mode an active skill causes an additional confirmation for `bash`, `shell`, `exec`, `python`, and `eval`. This is not a sandbox for arbitrary third-party tools. Remote `allowed-tools` does not grant permissions.

Manifest-backed files are checked against the server-provided byte size and SHA-256 digest. A digest establishes consistency, not trust in the server. Dynamic skills have no digest and require approval on every load. The loaded text identifies its origin; caches and approvals are not written to disk.

## Integration

This port targets OMP 19.2.1. It uses the MCP server connections already managed by OMP rather than starting a second stdio process or reading `mcp.json` credentials itself. The live manager is a version-sensitive host API. This is an OMP plugin, not native support in OMP's local skill catalog and not a plugin for upstream Pi.

Use the top-level OMP session. The plugin does not route restricted subagents through a parent connection. OMP 19.2.1 constructs request metadata from its shared client-capability object; the plugin advertises the Skills capability there while its binding is active. This does not add servers or modify their credentials.

## Development

```sh
bun install --frozen-lockfile
bun test src/host.test.ts
node test/smoke.mjs
```

The host and manifest validator are adapted from Richard Anaya's [pi-mcp-skills 0.1.0](https://www.npmjs.com/package/pi-mcp-skills/v/0.1.0). See [LICENSE](LICENSE) (MIT).
