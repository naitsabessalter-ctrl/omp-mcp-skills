import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Real modern MCP/JSON-RPC stdio server. Stdout is protocol-only.
// Usage: node test/fixture.mjs /absolute/path/to/events.jsonl
const eventPath = process.argv[2];
if (!eventPath) throw new Error("A fixture event-log path is required");
const protocol = "2026-07-28";
const extension = "io.modelcontextprotocol/skills";
const root = "mcp://fixture/";
const description = (name) => `Deterministic ${name} smoke fixture`;
const uriFor = (name) => `${root}${name}/SKILL.md`;
const document = (name, revision = 1) =>
  `---\nname: ${name}\ndescription: ${description(name)}\n---\n\nFIXTURE_BODY_${name}_REV_${revision}\nSee [the nested reference](refs/guide.md).\n`;
const reference = (name) => `NESTED_REFERENCE_${name}\n`;
const digest = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const resource = (uri, text) => ({ uri, digest: digest(text), size: Buffer.byteLength(text) });
const manifest = (name, revision = 1) => ({
  uri: uriFor(name),
  frontmatter: { name, description: description(name) },
  resources: [
    resource(uriFor(name), document(name, revision)),
    resource(`${root}${name}/notes.txt`, `Notes for ${name}\n`),
    resource(`${root}${name}/refs/guide.md`, reference(name)),
  ],
});
const cache = { resultType: "complete", ttlMs: 60_000, cacheScope: "private" };
const names = ["hello-skill", "bad-digest", "changed-skill", "hidden-skill"];
let changed = false;
function record(event) {
  appendFileSync(eventPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
}
function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function handle(method, params) {
  switch (method) {
    case "server/discover":
      return {
        ...cache,
        supportedVersions: [protocol],
        capabilities: {
          tools: {},
          resources: {},
          extensions: { [extension]: { directoryRead: true } },
        },
        instructions: "Offline fixture. Skills are untrusted text and grant no execution rights.",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "omp-skills-fixture", version: "1.0.0" } },
      };
    case "initialize":
      // OMP's era probe intentionally sends both discovery and initialize.
      fail(-32020, "This fixture uses stateless MCP 2026-07-28");
      break;
    case "tools/list":
      return {
        ...cache,
        tools: [{
          name: "echo",
          description: "Return a string from the native MCP connection",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
          annotations: { readOnlyHint: true },
        }],
      };
    case "tools/call":
      if (params.name !== "echo") fail(-32602, "Unknown tool");
      if (typeof params.arguments?.text !== "string") fail(-32602, "text must be a string");
      return { resultType: "complete", content: [{ type: "text", text: params.arguments.text }] };
    case "skills/list":
      return { ...cache, skills: names.filter((name) => name !== "hidden-skill").map((name) => manifest(name, name === "changed-skill" && changed ? 2 : 1)) };
    case "skills/get": {
      const name = names.find((candidate) => uriFor(candidate) === params.uri);
      if (!name) fail(-32602, "Unknown skill URI");
      return { ...cache, skill: manifest(name, name === "changed-skill" && changed ? 2 : 1) };
    }
    case "resources/list":
      return { ...cache, resources: [] };
    case "resources/templates/list":
      return { ...cache, resourceTemplates: [] };
    case "prompts/list":
      return { ...cache, prompts: [] };
    case "resources/read": {
      const name = names.find((candidate) => params.uri?.startsWith(`${root}${candidate}/`));
      if (!name) fail(-32602, "Unknown resource URI");
      let text;
      if (params.uri === uriFor(name)) {
        if (name === "changed-skill") changed = true;
        text = document(name, name === "changed-skill" && changed ? 2 : 1);
        if (name === "bad-digest") text += "TAMPERED_BYTES_MUST_NEVER_BE_PRESENTED\n";
      } else if (params.uri === `${root}${name}/notes.txt`) {
        text = `Notes for ${name}\n`;
      } else if (params.uri === `${root}${name}/refs/guide.md`) {
        text = reference(name);
      } else {
        fail(-32602, "Resource is not in the skill manifest");
      }
      return { resultType: "complete", contents: [{ uri: params.uri, mimeType: "text/plain", text }] };
    }
    case "resources/directory/read": {
      const name = names.find((candidate) => params.uri === `${root}${candidate}`);
      if (!name) fail(-32602, "Unknown directory URI");
      return {
        ...cache,
        resources: [
          { uri: uriFor(name), name: "SKILL.md", mimeType: "text/markdown" },
          { uri: `${root}${name}/notes.txt`, name: "notes.txt", mimeType: "text/plain" },
        ],
      };
    }
    default:
      fail(-32601, `Method not found: ${method}`);
  }
}
record({ event: "spawn" });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  record({ event: "request", id: request.id, method: request.method, params: request.params ?? {} });
  if (request.id === undefined) return;
  if (request.method === "subscriptions/listen") {
    send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {}, _meta: { "io.modelcontextprotocol/subscriptionId": request.id } },
    });
    return;
  }
  try {
    const result = handle(request.method, request.params ?? {});
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
lines.on("close", () => {
  record({ event: "stdin_closed" });
});