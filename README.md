# omp-mcp-skills

Use skills published by MCP servers from [Oh My Pi](https://github.com/can1357/oh-my-pi). The agent sees their names and descriptions automatically, starting with the first ordinary prompt. Skill files are read only when needed; nothing is installed on disk.

## Install

```sh
omp plugin install github:naitsabessalter-ctrl/omp-mcp-skills
```

Start a new OMP session. Configure the MCP server in OMP as usual; the plugin has no separate credential store or MCP config. The server must declare both `resources` and `io.modelcontextprotocol/skills` and implement the [MCP Skills specification](https://modelcontextprotocol.io/extensions/skills/overview). Ordinary MCP tools, resources, and local `SKILL.md` files do not by themselves constitute support.

## Use

Describe your task normally. OMP sees the server catalog before the model answers and uses its **built-in `read` tool** for the skill and its supporting files. The plugin registers a read-only `mcp-skill://` URI scheme, not a model tool or slash command. No skill loader, approval flag or plugin confirmation dialog is involved. Local `skill://` resolution stays unchanged.

Enabling an MCP server means its skills can be read automatically. Treat them as third-party instructions, even when integrity checks pass. Manifest-backed files are checked against the listed byte length and SHA-256 digest; dynamic skills have no content digest. The plugin does not execute skill files, grant shell access, change OMP's own tool approvals or persist the remote skills as installed files.

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
