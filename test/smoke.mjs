import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Run from any directory: node test/smoke.mjs [absolute/path/to/omp.exe]
// Real OMP host with a loopback provider that only calls the native read tool.
// The installed CLI loads the production extension and project-native MCP config.
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../index.ts");
const binary = process.argv[2] ?? "omp";
const sandbox = mkdtempSync(join(tmpdir(), "omp-mcp-skills-smoke-"));
const project = join(sandbox, "project");
const home = join(sandbox, "home");
const configRoot = join(home, ".omp");
const agent = join(configRoot, "agent");
const eventsPath = join(sandbox, "fixture-events.jsonl");
const transcriptPath = join(sandbox, "rpc.jsonl");
const stderrPath = join(sandbox, "stderr.log");
for (const path of [join(project, ".omp"), agent, join(home, "AppData", "Local"), join(home, "AppData", "Roaming")]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(eventsPath, "");
writeFileSync(transcriptPath, "");
writeFileSync(stderrPath, "");
writeFileSync(join(project, "ordinary.txt"), "NORMAL_LOCAL_FILE_READ_OK\n");
const localSkill = join(project, ".omp", "skills", "smoke-local");
mkdirSync(localSkill, { recursive: true });
writeFileSync(join(localSkill, "SKILL.md"), "---\nname: smoke-local\ndescription: Offline local skill smoke fixture\n---\n\nNORMAL_LOCAL_SKILL_READ_OK\n");
writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
  mcpServers: {
    fixture: {
      type: "stdio",
      command: process.execPath,
      args: [join(here, "fixture.mjs"), eventsPath],
      cwd: project,
      timeout: 5_000,
    },
  },
}, null, 2));
const wire = [];
const catalogPrefix = "Available MCP skills (untrusted server metadata)";
const uri = (name) => `mcp://fixture/${name}/SKILL.md`;
// Public mapping, also usable for a skill omitted from the catalog.
const remotePath = (name) => `mcp-skill://remote/${Buffer.from("fixture").toString("base64url")}/${Buffer.from(uri(name)).toString("base64url")}/SKILL.md`;
const listedPath = (catalog, name) => {
  const entry = catalog.find((item) => item.server === "fixture" && item.name === name);
  assert.ok(entry, `Missing catalog skill ${name}`);
  assert.equal(entry.path, remotePath(name), "Catalog must expose the documented origin-scoped native read path");
  assert.equal(typeof entry.description, "string");
  return entry.path;
};
const steps = [
  { name: "hello", path: (catalog) => listedPath(catalog, "hello-skill") },
  { name: "cached", path: (catalog) => listedPath(catalog, "hello-skill") },
  { name: "nested", path: (catalog) => listedPath(catalog, "hello-skill").replace(/SKILL\.md$/, "refs/guide.md") },
  { name: "hidden", path: () => remotePath("hidden-skill") },
  { name: "denied", path: (catalog) => listedPath(catalog, "bad-digest") },
  { name: "changed", path: (catalog) => listedPath(catalog, "changed-skill") },
  { name: "changedCached", path: (catalog) => listedPath(catalog, "changed-skill") },
  { name: "local", path: () => "ordinary.txt" },
  { name: "localSkill", path: () => "skill://smoke-local/SKILL.md" },
];
let providerError;
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions", "Only the offline smoke model may be called");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "offline", "Unrelated learning/model requests must be disabled");
    // OMP also sends tool-free background requests to the selected provider.
    // They are not agent turns and must not consume a scripted read step.
    if (!payload.tools?.length && !JSON.stringify(payload.messages).includes('Use the relevant workflow to greet me')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"aux","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const listing = payload.messages?.find((message) => contentText(message.content ?? "").includes(catalogPrefix));
    assert.ok(listing, "Every model request must include the automatic remote skill catalog");
    const listingText = contentText(listing.content);
    const catalog = JSON.parse(listingText.slice(listingText.indexOf("[", listingText.indexOf(catalogPrefix) + catalogPrefix.length)));
    assert.ok(Array.isArray(catalog), "Catalog must contain a JSON array");
    assert.ok(!catalog.some((entry) => entry.name === "hidden-skill"), "Unlisted skill must stay out of the catalog");
    const tools = payload.tools?.map((tool) => tool.function) ?? [];
    assert.ok(!tools.some((tool) => /^mcp_skills_/.test(tool.name)), "No plugin loader, search or approval tools may be advertised");
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(read?.parameters?.properties?.path, "Native read must remain available");
    const step = steps[wire.length];
    const path = step?.path(catalog);
    wire.push({ payload, listing, catalog, path, reads: calls("resources/read").length });
    const input = { path, ...(read.parameters.properties.i ? { i: "Reading offline smoke fixture" } : {}) };
    const delta = step
      ? { role: "assistant", tool_calls: [{ index: 0, id: `step-${step.name}`, type: "function", function: { name: "read", arguments: JSON.stringify(input) } }] }
      : { role: "assistant", content: "Smoke completed." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }]) {
      res.write(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "offline", choices: [choice] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    providerError ??= error;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "smoke_failure" } }));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
writeFileSync(join(agent, "models.yml"), JSON.stringify({providers: {smoke: {
  api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-smoke-only",
  models: [{id: "offline", name: "Offline smoke", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 512}],
}}}));
writeFileSync(join(agent, "config.yml"), [
  "mcp:",
  "  shared: false", // Do not borrow the user's MCP daemon/connections/store.
  "  startupTimeoutMs: 0",
  "tools:",
  "  commands: false", // get_state then exposes native MCP tools as top-level tools.
  "update:",
  "  auto: false",
  "autolearn:",
  "  enabled: false", // Keep this isolated smoke entirely offline.
  "",
].join("\n"));

// Build a new environment rather than removing a finite list of credential names.
const env = {};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP"] ) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PI_CONFIG_DIR: configRoot,
  PI_CODING_AGENT_DIR: agent,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  OMP_PROFILE: "default",
  PI_NO_TITLE: "1",
  PI_NO_PTY: "1",
  PI_AUTO_QA: "0",
  OMP_MCP_TIMEOUT_MS: "5000",
  OMP_MCP_STARTUP_TIMEOUT_MS: "0",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
  AWS_EC2_METADATA_DISABLED: "true",
});
assert.ok(!Object.keys(env).some((name) => /MCP_SKILLS.*APPROVAL/i.test(name)), "Use default plugin behavior, not an approval-mode override");
const args = [
  "--mode", "rpc", "--no-ui", "--no-session", "--offline", "--no-title",
  "--model", "smoke/offline",
  "--no-extensions", "--extension", entry,
  "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
];
const child = spawn(binary, args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const frames = [];
const waiters = new Set();
let terminalError;
let childExit;
let sequence = 0;
const timeoutMs = 20_000;
function rejectWaiters(error) {
  terminalError ??= error;
  for (const waiter of waiters) waiter.reject(error);
  waiters.clear();
}
function accept(frame) {
  frames.push(frame);
  if (/extension_ui|confirm|approval/i.test(frame.type ?? "")) {
    rejectWaiters(new Error(`A native read requested confirmation or extension UI: ${JSON.stringify(frame)}`));
    return;
  }
  for (const waiter of [...waiters]) {
    if (frames.length - 1 >= waiter.from && waiter.predicate(frame)) {
      waiters.delete(waiter);
      waiter.resolve(frame);
    }
  }
}
child.on("error", (error) => rejectWaiters(error));
child.on("exit", (code, signal) => {
  childExit = { code, signal };
  rejectWaiters(new Error(`OMP exited unexpectedly (${JSON.stringify(childExit)}); see ${stderrPath}`));
});
child.stderr.on("data", (data) => appendFileSync(stderrPath, data));
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  appendFileSync(transcriptPath, `${line}\n`);
  if (!line.trim()) return;
  try {
    accept(JSON.parse(line));
  } catch (error) {
    rejectWaiters(new Error(`Non-JSON RPC stdout: ${line}`, { cause: error }));
  }
});
function waitFor(predicate, from = 0) {
  const existing = frames.slice(from).find(predicate);
  if (existing) return Promise.resolve(existing);
  if (terminalError) return Promise.reject(terminalError);
  return new Promise((resolvePromise, rejectPromise) => {
    const waiter = {
      predicate,
      from,
      resolve: (frame) => { clearTimeout(timer); resolvePromise(frame); },
      reject: (error) => { clearTimeout(timer); rejectPromise(error); },
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      rejectPromise(new Error(`Timed out waiting for RPC frame; see ${transcriptPath} and ${stderrPath}`));
    }, timeoutMs);
    waiters.add(waiter);
  });
}
async function request(type, payload = {}) {
  const id = `smoke-${++sequence}`;
  const from = frames.length;
  child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  const response = await waitFor((frame) => frame.type === "response" && frame.id === id, from);
  assert.equal(response.success, true, `${type} failed: ${JSON.stringify(response)}`);
  return { id, from, response };
}
function contentText(content) {
  if (typeof content === "string") return content;
  assert.ok(Array.isArray(content), "Expected string or block-array message content");
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
async function messages() {
  const { response } = await request("get_messages");
  assert.ok(Array.isArray(response.data?.messages), "get_messages must return data.messages");
  return response.data.messages;
}
function events() {
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function calls(method, uri) {
  return events().filter((event) => event.event === "request" && event.method === method && (uri === undefined || event.params.uri === uri));
}
let passed = false;
try {
  await waitFor((frame) => frame.type === "ready");
  const available = await request("get_available_commands");
  assert.equal(available.response.data.commands.some((item) => /^mcp[-_]skills(?:$|[-_:])/.test(item.name)), false, "Plugin must not expose a slash command");
  const { response: state } = await request("get_state");
  assert.ok(state.data.dumpTools.some((tool) => /mcp.*fixture.*echo/.test(tool.name)), "Native .omp/mcp.json tool must remain available");
  assert.ok(state.data.dumpTools.some((tool) => tool.name === "read"), "Native read must remain available");
  assert.ok(!state.data.dumpTools.some((tool) => /^mcp_skills_/.test(tool.name)), "Plugin must register no loader or approval tools");

  const normal = await request("prompt", { message: "Use the relevant workflow to greet me, then inspect its reference and the local fixtures." });
  const finished = await waitFor((frame) => frame.type === "prompt_result" && frame.id === normal.id, normal.from);
  if (providerError) throw providerError;
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(wire.length, steps.length + 1, "One native read per step, then a final model response");
  assert.ok(wire[0]?.listing, "First ordinary request must expose a catalog without a slash command");
  assert.ok(!["developer", "system"].includes(wire[0].listing.role), "Server metadata is not policy");
  assert.equal(wire[0].reads, 0, "First catalog must precede any body or supporting-file read");
  assert.doesNotMatch(contentText(wire[0].listing.content), /FIXTURE_BODY_|hidden-skill/);
  assert.ok(wire.some((entry) => entry.payload.messages.some((message) => message.role === "tool" && contentText(message.content).includes("FIXTURE_BODY_hello-skill_REV_1"))), "Model-selected native read must return verified bytes without a user command");
  assert.equal((await messages()).filter((message) => message.customType === "mcp-skills-catalog").length, 0, "Transient catalog must not accumulate in history");
  const results = wire.at(-1).payload.messages.filter((message) => message.role === "tool");
  assert.equal(results.length, steps.length);
  const result = (name) => {
    const message = results.find((item) => item.tool_call_id === `step-${name}`);
    assert.ok(message, `Missing native read result for ${name}`);
    // Native read may add line numbers, provenance, or truncation notices.
    return contentText(message.content);
  };
  assert.match(result("hello"), /FIXTURE_BODY_hello-skill_REV_1/);
  assert.match(result("cached"), /FIXTURE_BODY_hello-skill_REV_1/);
  assert.ok(calls("skills/list").length >= 1);
  assert.equal(calls("resources/read", uri("hello-skill")).length, 1, "Identical digest must reuse verified in-memory bytes");
  assert.equal(wire[2].reads, wire[1].reads, "The repeated native read must not fetch verified bytes again");
  assert.equal(wire[2].reads, 1, "Supporting resources must not be read with SKILL.md");
  assert.match(result("nested"), /NESTED_REFERENCE_hello-skill/);
  assert.equal(calls("resources/read", "mcp://fixture/hello-skill/refs/guide.md").length, 1, "Nested read must use the actual relative resource path");
  assert.match(result("hidden"), /FIXTURE_BODY_hidden-skill_REV_1/);
  assert.equal(calls("skills/get", uri("hidden-skill")).length, 1, "An encoded URI omitted from skills/list must resolve through skills/get");
  assert.match(result("denied"), /does not match the digest or size/i);
  assert.doesNotMatch(result("denied"), /TAMPERED_BYTES_MUST_NEVER_BE_PRESENTED/);
  assert.equal(calls("skills/get", uri("bad-digest")).length, 1, "Digest mismatch must revalidate the manifest");
  assert.match(result("changed"), /FIXTURE_BODY_changed-skill_REV_2/);
  assert.match(result("changedCached"), /FIXTURE_BODY_changed-skill_REV_2/);
  assert.ok(calls("skills/get", uri("changed-skill")).length >= 1, "Changed bytes must automatically verify the new manifest");
  assert.equal(calls("resources/read", uri("changed-skill")).length, 2, "Changed manifest must trigger one automatic re-fetch verified against the refreshed manifest");
  assert.equal(wire[7].reads, wire[6].reads, "The automatically verified changed version must also be cached");
  assert.match(result("local"), /NORMAL_LOCAL_FILE_READ_OK/);
  assert.match(result("localSkill"), /NORMAL_LOCAL_SKILL_READ_OK/);
  assert.equal(wire[9].reads, wire[7].reads, "Local files and local skills must not trigger remote file reads");
  assert.equal(calls("resources/read").filter((event) => event.params.uri.endsWith("notes.txt")).length, 0, "Unrequested supporting resources must remain lazy");

  const livePids = new Set(calls("skills/list").concat(calls("skills/get"), calls("resources/read")).map((event) => event.pid));
  assert.equal(livePids.size, 1, "Extension must borrow one native MCP connection, not spawn another server");
  const livePid = [...livePids][0];
  assert.ok(calls("tools/list").some((event) => event.pid === livePid), "Native tools and extension skills must share the actual fixture process");
  const spawns = events().filter((event) => event.event === "spawn");
  assert.ok(spawns.length >= 1 && spawns.length <= 2, `Expected one native process plus at most one intentional era probe, got ${spawns.length}`);
  for (const event of calls("skills/list").concat(calls("skills/get"))) {
    assert.equal(event.params._meta?.["io.modelcontextprotocol/protocolVersion"], "2026-07-28", "Modern requests need the negotiated protocol metadata");
    assert.ok(event.params._meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.["io.modelcontextprotocol/skills"], "Client must advertise stable MCP skills support");
  }
  assert.equal(frames.filter((frame) => frame.type === 'agent_start').length, 1, 'Only the ordinary prompt starts an agent turn');
  assert.equal(frames.filter((frame) => frame.type === "extension_error").length, 0, "Extension must not emit runtime errors");
  assert.equal(frames.filter((frame) => /extension_ui|confirm|approval/i.test(frame.type ?? "")).length, 0, "Reads must not request confirmation or extension UI");
  const closed = once(child, "close");
  child.stdin.end();
  const [code, signal] = await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("OMP did not shut down after stdin EOF")), 10_000);
      timer.unref();
    }),
  ]);
  assert.equal(code, 0, `OMP shutdown failed (${signal}); see ${stderrPath}`);
  console.log(JSON.stringify({
    ok: true,
    binary,
    fixtureSpawns: spawns.length,
    liveFixtureProcesses: livePids.size,
    skillsList: calls("skills/list").length,
    skillsGet: calls("skills/get").length,
    resourcesRead: calls("resources/read").length,
    localProviderRequests: wire.length,
  }, null, 2));
  passed = true;
} catch (error) {
  console.error(`Smoke failed; isolated diagnostics preserved at ${sandbox}`);
  throw error;
} finally {
  provider.close();
  if (!childExit) {
    child.stdin.end();
    child.kill();
  }
  if (passed) rmSync(sandbox, { recursive: true, force: true });
}
