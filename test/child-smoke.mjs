import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Run from any directory: node test/child-smoke.mjs [absolute/path/to/omp.exe]
const here = dirname(fileURLToPath(import.meta.url));
const binary = process.argv[2] ?? "omp";
const sandbox = mkdtempSync(join(tmpdir(), "omp-mcp-skills-child-"));
const project = join(sandbox, "project");
const home = join(sandbox, "home");
const configRoot = join(home, ".omp");
const agent = join(configRoot, "agent");
const agentName = "offline-skills-reader";
const loaderId = "ScopeLoader";
const readerId = "SkillReader";
const rootPrompt = "CHILD_SMOKE_ROOT: run the fixture assignments in order.";
const loaderPrompt = "CHILD_SMOKE_LOADER: call the fixture's native echo.";
const readerPrompt = "CHILD_SMOKE_READER: use the automatic skill catalog and native read.";
const catalogPrefix = "Available MCP skills (untrusted server metadata)";
const helloBody = "FIXTURE_BODY_hello-skill_REV_1";
const helloReference = "NESTED_REFERENCE_hello-skill";
const foreignBody = "FIXTURE_BODY_foreign-skill_REV_1";
const scopeToken = "FOREIGN_ORIGIN_SCOPED";
const readerDone = "Reader verified the scoped native reads.";
const loaderDone = "Loader acquired the scoped MCP tool.";

for (const path of [join(project, ".omp", "agents"), agent, join(home, "AppData", "Local"), join(home, "AppData", "Roaming")]) {
  mkdirSync(path, { recursive: true });
}
const mcpServers = Object.fromEntries(["fixture", "foreign"].map((origin) => {
  const eventPath = join(sandbox, `${origin}.jsonl`);
  writeFileSync(eventPath, "");
  return [origin, {
    type: "stdio", command: process.execPath, args: [join(here, "fixture.mjs"), eventPath, origin],
    cwd: project, timeout: 5_000, instructions: false,
  }];
}));
writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({ mcpServers }));
writeFileSync(join(project, ".omp", "agents", `${agentName}.md`), [
  "---", `name: ${agentName}`, "description: Offline MCP skill scope smoke agent",
  "model: smoke/offline", "thinking-level: off", "tools: [read]", "blocking: true",
  "read-summarize: false", "---", "Read and report the assigned fixture content.", "",
].join("\n"));
writeFileSync(join(agent, "config.yml"), [
  "mcp:", "  shared: false", "  startupTimeoutMs: 0",
  "tools:", "  commands: false",
  "task:", "  batch: true", "  structured: false", "  speculativeLaunch: false",
  "async:", "  enabled: false",
  "providers:", "  cacheWarming: off",
  "update:", "  auto: false", "autolearn:", "  enabled: false", "",
].join("\n"));

function text(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function upstream(origin, method) {
  return readFileSync(join(sandbox, `${origin}.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse)
    .filter((event) => event.event === "request" && event.method === method);
}
const uri = (origin, name) => `mcp://${origin}/${name}/SKILL.md`;
const b64 = (value) => Buffer.from(value).toString("base64url");
const skillPath = (origin, name) => `mcp-skill://remote/${b64(origin)}/${b64(uri(origin, name))}/SKILL.md`;
const helloPath = skillPath("fixture", "hello-skill");
const guidePath = helloPath.replace(/SKILL\.md$/, "refs/guide.md");
const foreignPath = skillPath("foreign", "foreign-skill");
const readerSteps = [
  { id: "reader-doc", path: helloPath, expected: helloBody },
  { id: "reader-guide", path: guidePath, expected: helloReference },
  { id: "reader-foreign", path: foreignPath },
];

function catalog(payload) {
  const listing = payload.messages.find((message) => text(message.content).includes(catalogPrefix));
  assert.ok(listing, "Expected the automatic MCP skills catalog in the model payload");
  assert.notEqual(listing.role, "developer");
  assert.notEqual(listing.role, "system");
  const listingText = text(listing.content);
  const start = listingText.indexOf(catalogPrefix) + catalogPrefix.length;
  const entries = JSON.parse(listingText.slice(listingText.indexOf("[", start)));
  assert.ok(Array.isArray(entries));
  assert.doesNotMatch(listingText, /FIXTURE_BODY_|NESTED_REFERENCE_/);
  return entries;
}
function requireSkill(entries, origin, name) {
  const entry = entries.find((item) => item.server === origin && item.name === name);
  assert.ok(entry, `Missing ${origin}/${name} from the MCP skill catalog`);
  assert.equal(entry.path, skillPath(origin, name));
  assert.equal(entry.description, `Deterministic ${name} smoke fixture`);
  return entry.path;
}
function toolResult(payload, id) {
  const result = payload.messages.find((message) => message.role === "tool" && message.tool_call_id === id);
  assert.ok(result, `Missing tool result ${id}`);
  return text(result.content);
}
function toolCall(tools, name, id, args, intent) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `Missing supported tool ${name}`);
  if (tool.parameters?.properties?.i) args = { ...args, i: intent };
  return { role: "assistant", tool_calls: [{
    index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) },
  }] };
}
function taskCall(tools, id, name, assignment) {
  return toolCall(tools, "task", id, {
    context: "Offline child MCP skills scope test.",
    tasks: [{ name, agent: agentName, task: assignment, solutionSpace: "Scripted native tool calls." }],
  }, "Spawning offline smoke child");
}
function respond(res, delta) {
  const finish = delta.tool_calls ? "tool_calls" : "stop";
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) {
    res.write(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "offline", choices: [choice] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}
const isForeignTool = (tool) => /^mcp.*foreign.*(?:echo|scope_only)$/.test(tool.name);
const noPluginTool = (tool) => !/^mcp[-_]skills(?:$|[-_:])/.test(tool.name);
const turns = { root: 0, loader: 0, reader: 0 };
let providerError;
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    appendFileSync(join(sandbox, "provider.jsonl"), `${JSON.stringify(payload)}\n`);
    assert.equal(payload.model, "offline");
    const tools = payload.tools?.map((tool) => tool.function) ?? [];
    assert.ok(tools.every(noPluginTool), "No plugin tools may be exposed");
    const hasPrompt = (prompt) => payload.messages.some((message) => message.role === "user" && text(message.content).includes(prompt));
    if (!tools.length) {
      respond(res, { role: "assistant", content: "OK" });
      return;
    }

    let delta;
    if (hasPrompt(readerPrompt)) {
      const index = turns.reader++;
      assert.ok(index <= readerSteps.length, "Unexpected extra reader request");
      const entries = catalog(payload);
      assert.ok(!entries.some((item) => item.server === "foreign" || item.name === "foreign-skill"), "Scoped-out origin must not be cataloged");
      assert.ok(!tools.some(isForeignTool), "Reader must have no native tools from the foreign origin");
      const listed = requireSkill(entries, "fixture", "hello-skill");
      if (index === 0) {
        assert.equal(upstream("fixture", "resources/read").length, 0, "First child payload must precede all allowed body reads");
        assert.doesNotMatch(JSON.stringify(payload.messages), /foreign-skill|FIXTURE_BODY_|NESTED_REFERENCE_/);
      } else {
        const previous = readerSteps[index - 1];
        const result = toolResult(payload, previous.id);
        if (previous.expected) assert.ok(result.includes(previous.expected), result);
        else {
          assert.match(result, /MCP skill server is not available to the calling subagent/);
          assert.ok(!result.includes(foreignBody), "Guessed foreign path returned a protected body");
        }
      }
      const step = readerSteps[index];
      delta = step
        ? toolCall(tools, "read", step.id, { path: index === 0 ? listed : index === 1 ? "skill://hello-skill/refs/guide.md" : step.path }, "Reading fixture in child")
        : { role: "assistant", content: readerDone };
    } else if (hasPrompt(loaderPrompt)) {
      const index = turns.loader++;
      assert.ok(index <= 1, "Unexpected extra loader request");
      requireSkill(catalog(payload), "foreign", "foreign-skill");
      if (index === 0) {
        const echo = tools.find((tool) => isForeignTool(tool) && tool.name.endsWith("echo"));
        assert.ok(echo, "First child must inherit the known foreign MCP tool");
        delta = toolCall(tools, echo.name, "loader-echo", { text: scopeToken }, "Switching native MCP tool scope");
      } else {
        assert.ok(toolResult(payload, "loader-echo").includes(scopeToken));
        assert.ok(tools.some((tool) => isForeignTool(tool) && tool.name.endsWith("scope_only")), "Only the calling child gains the replacement tool");
        delta = { role: "assistant", content: loaderDone };
      }
    } else {
      assert.ok(hasPrompt(rootPrompt), "Unexpected model turn");
      const index = turns.root++;
      assert.ok(index <= 3, "Unexpected extra parent request");
      const entries = catalog(payload);
      requireSkill(entries, "fixture", "hello-skill");
      const listedForeign = requireSkill(entries, "foreign", "foreign-skill");
      if (index === 0) {
        // Preload verified foreign bytes in the owner. The later sibling must not read this cache.
        delta = toolCall(tools, "read", "owner-foreign", { path: listedForeign }, "Priming owner-only skill cache");
      } else if (index === 1) {
        assert.ok(toolResult(payload, "owner-foreign").includes(foreignBody));
        delta = taskCall(tools, "task-loader", loaderId, loaderPrompt);
      } else if (index === 2) {
        assert.ok(toolResult(payload, "task-loader").includes(loaderDone));
        assert.ok(!tools.some(isForeignTool), "Replacement MCP tool must not transfer to the parent scope");
        delta = taskCall(tools, "task-reader", readerId, readerPrompt);
      } else {
        assert.ok(toolResult(payload, "task-reader").includes(readerDone));
        delta = { role: "assistant", content: "Child smoke completed." };
      }
    }
    respond(res, delta);
  } catch (error) {
    providerError ??= error;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "smoke_failure" } }));
  }
});
await new Promise((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { smoke: {
  api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-smoke-only",
  models: [{ id: "offline", name: "Offline smoke", reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 512 }],
} } }));

const env = {};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  HOME: home, USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
  PI_CONFIG_DIR: configRoot, PI_CODING_AGENT_DIR: agent, CLAUDE_CONFIG_DIR: join(home, ".claude"), OMP_PROFILE: "default",
  PI_NO_TITLE: "1", PI_NO_PTY: "1", PI_AUTO_QA: "0", OMP_MCP_TIMEOUT_MS: "5000", OMP_MCP_STARTUP_TIMEOUT_MS: "0",
  DO_NOT_TRACK: "1", NO_COLOR: "1", AWS_EC2_METADATA_DISABLED: "true",
});
const omp = spawn(binary, [
  "--mode", "rpc", "--no-ui", "--no-session", "--offline", "--no-title", "--model", "smoke/offline",
  "--no-extensions", "--extension", resolve(here, "../index.ts"), "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const frames = [];
let rpcError;
let closed = false;
let notify;
let sequence = 0;
const closing = new Promise((resolvePromise) => omp.once("close", (code, signal) => {
  closed = true;
  rpcError ??= new Error(`OMP closed (${code ?? signal})`);
  notify?.();
  resolvePromise({ code, signal });
}));
omp.on("error", (error) => { rpcError ??= error; notify?.(); });
omp.stdin.on("error", (error) => { rpcError ??= error; notify?.(); });
omp.stderr.on("data", (data) => appendFileSync(join(sandbox, "stderr.log"), data));
createInterface({ input: omp.stdout, crlfDelay: Infinity }).on("line", (line) => {
  appendFileSync(join(sandbox, "rpc.jsonl"), `${line}\n`);
  if (!line.trim()) return;
  try {
    const frame = JSON.parse(line);
    frames.push(frame);
    if (/extension_error|extension_ui|confirm|approval/i.test(frame.type ?? "")) {
      rpcError ??= new Error(`Unexpected extension or approval RPC frame: ${line}`);
    }
  } catch (error) {
    rpcError ??= error;
  }
  notify?.();
});
function waitFor(predicate, description) {
  assert.equal(notify, undefined, "RPC waits must run in sequence");
  return new Promise((resolvePromise, rejectPromise) => {
    let from = 0;
    const timer = setTimeout(() => finish(rejectPromise, new Error(`Timed out waiting for ${description}`)), 20_000);
    function finish(settle, value) {
      notify = undefined;
      clearTimeout(timer);
      settle(value);
    }
    notify = () => {
      if (rpcError) return finish(rejectPromise, rpcError);
      while (from < frames.length) {
        const frame = frames[from++];
        if (predicate(frame)) return finish(resolvePromise, frame);
      }
    };
    notify();
  });
}
async function request(type, data = {}) {
  const id = `child-smoke-${++sequence}`;
  omp.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
  const response = await waitFor((frame) => frame.type === "response" && frame.id === id, type);
  assert.equal(response.success, true, JSON.stringify(response));
  return response;
}
let passed = false;
try {
  await waitFor((frame) => frame.type === "ready", "OMP ready");
  const { data: { commands } } = await request("get_available_commands");
  assert.ok(commands.every(noPluginTool), "No plugin slash commands may be exposed");
  await request("set_subagent_subscription", { level: "events" });
  await request("set_auto_retry", { enabled: false });
  const prompt = await request("prompt", { message: rootPrompt });
  const finished = await waitFor((frame) => frame.type === "prompt_result" && frame.id === prompt.id, "root prompt completion");
  if (providerError) throw providerError;
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(finished.agentInvoked, true);
  assert.deepEqual(turns, { root: 4, loader: 2, reader: 4 });

  const started = frames.filter((frame) => frame.type === "subagent_lifecycle" && frame.payload.status === "started");
  assert.deepEqual(started.map(({ payload }) => [payload.id, payload.agent, payload.parentToolCallId]), [
    [loaderId, agentName, "task-loader"], [readerId, agentName, "task-reader"],
  ], "Both sessions must be real children of matching native task calls");
  const readerEvents = frames.filter((frame) => frame.type === "subagent_event" && frame.payload.id === readerId)
    .map((frame) => frame.payload.event);
  const reads = readerEvents.filter((event) => event.type === "tool_execution_start");
  assert.deepEqual(reads.map((event) => [event.toolCallId, event.toolName, event.args.path]),
    readerSteps.map(({ id, path }) => [id, "read", path]), "Child must execute the native read tool on all three paths");
  const results = readerEvents.filter((event) => event.type === "tool_execution_end");
  assert.deepEqual(results.map((event) => [event.toolCallId, event.toolName]), readerSteps.map(({ id }) => [id, "read"]));
  assert.ok(results[2].isError, "Guessed foreign path must fail native read");
  assert.equal(Boolean(results[0].isError || results[1].isError), false);

  const allowedReads = upstream("fixture", "resources/read");
  assert.deepEqual(allowedReads.map((event) => event.params.uri), [uri("fixture", "hello-skill"), "mcp://fixture/hello-skill/refs/guide.md"]);
  const allowedLists = upstream("fixture", "skills/list");
  assert.ok(allowedLists.length > 0, "Catalog must be fetched from the real fixture");
  const pids = new Set([...allowedReads, ...allowedLists, ...upstream("fixture", "tools/list")].map((event) => event.pid));
  assert.equal(pids.size, 1, "Owner discovery and both child reads must share one upstream serving PID");
  const foreignReads = upstream("foreign", "resources/read");
  assert.deepEqual(foreignReads.map((event) => event.params.uri), [uri("foreign", "foreign-skill")], "Only the owner may read foreign content");
  assert.equal(upstream("foreign", "skills/get").length, 0, "Guessed path must not trigger foreign manifest discovery");
  assert.deepEqual(upstream("foreign", "tools/call").map((event) => event.params.name), ["echo"], "The loader must switch scope via a real native MCP call");
  assert.equal(rpcError, undefined);

  omp.stdin.end();
  const { code, signal } = await Promise.race([closing, new Promise((_, reject) => {
    setTimeout(() => reject(new Error("OMP did not shut down after stdin EOF")), 10_000).unref();
  })]);
  assert.equal(code, 0, `OMP shutdown failed (${signal})`);
  console.log(JSON.stringify({
    ok: true, binary, childId: readerId, loaderId, catalogInFirstChildPayload: true,
    allowedOrigin: "fixture", allowedServingPid: [...pids][0], allowedReads: allowedReads.map((event) => event.params.uri),
    deniedOrigin: "foreign", deniedRead: foreignPath,
  }, null, 2));
  passed = true;
} catch (error) {
  console.error(`Child smoke failed; isolated diagnostics preserved at ${sandbox}`);
  throw providerError ?? error;
} finally {
  provider.close();
  provider.closeAllConnections();
  if (!closed) {
    omp.stdin.end();
    omp.kill();
  }
  if (passed) rmSync(sandbox, { recursive: true, force: true });
}
