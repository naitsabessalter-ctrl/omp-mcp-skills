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
// Real OMP host with a loopback provider that can only select the advertised fixture skill.
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
const provider = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const listing = payload.messages?.find(m => JSON.stringify(m.content).includes('Available MCP skills (untrusted server metadata)'));
  const select = wire.length === 0 && listing && JSON.stringify(listing).includes('hello-skill');
  wire.push({payload, listing, reads: calls('resources/read').length});
  const delta = select ? {role:'assistant', tool_calls:[{index:0,id:'load-1',type:'function',function:{name:'mcp_skills_load',arguments:JSON.stringify({server:'fixture',skill:'mcp://fixture/hello-skill/SKILL.md',approve:true})}}]} : {role:'assistant',content:'Smoke completed.'};
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const choice of [{index:0, delta, finish_reason:null}, {index:0, delta:{}, finish_reason:select?'tool_calls':'stop'}]) {
    res.write(`data: ${JSON.stringify({id:'fixture-response',object:'chat.completion.chunk',created:1,model:'offline',choices:[choice]})}\n\n`);
  }
  res.end('data: [DONE]\n\n');
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
  OMP_MCP_SKILLS_APPROVALS: "tool",
  OMP_MCP_STARTUP_TIMEOUT_MS: "0",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
  AWS_EC2_METADATA_DISABLED: "true",
});
const args = [
  "--mode", "rpc", "--no-ui", "--no-session", "--offline", "--no-title",
  "--model", "smoke/offline",
  "--no-extensions", "--extension", entry,
  "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
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
async function command(text) {
  const before = (await messages()).filter((message) => message.customType === "mcp-skills").length;
  const { id, from, response } = await request("prompt", { message: text });
  if (response.data?.agentInvoked !== false) {
    const result = await waitFor((frame) => frame.type === "prompt_result" && frame.id === id, from);
    assert.equal(result.agentInvoked, false, "Slash command must not start a model turn");
    assert.equal(result.status, "completed", JSON.stringify(result));
  }
  const output = (await messages()).filter((message) => message.customType === "mcp-skills");
  assert.equal(output.length, before + 1, `Expected exactly one mcp-skills result for ${text}`);
  assert.equal(output.at(-1).display, true, "User-command result must be visible");
  return contentText(output.at(-1).content);
}
function events() {
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function calls(method, uri) {
  return events().filter((event) => event.event === "request" && event.method === method && (uri === undefined || event.params.uri === uri));
}
const uri = (name) => `mcp://fixture/${name}/SKILL.md`;
let passed = false;
try {
  await waitFor((frame) => frame.type === "ready");
  const available = await request("get_available_commands");
  assert.ok(available.response.data.commands.some((item) => item.name === "mcp-skills"), "Production /mcp-skills command must be loaded");
  const { response: state } = await request("get_state");
  assert.ok(state.data.dumpTools.some((tool) => /mcp.*fixture.*echo/.test(tool.name)), "Native .omp/mcp.json tool must remain available");
  assert.ok(state.data.dumpTools.some((tool) => tool.name === "mcp_skills_search"), "Production skill tool must be registered");

  const normal = await request('prompt', {message:'Use the relevant workflow to greet me.'});
  const finished = await waitFor(f => f.type === 'prompt_result' && f.id === normal.id, normal.from);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.ok(wire[0]?.listing, 'First ordinary request must expose a catalog without a slash command');
  assert.ok(!['developer','system'].includes(wire[0].listing.role), 'Server metadata is not policy');
  assert.equal(wire[0].reads, 0, 'First catalog must precede any body read');
  assert.doesNotMatch(JSON.stringify(wire[0].listing.content), /FIXTURE_BODY_|hidden-skill/);
  assert.ok(wire.some(w => w.payload.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('FIXTURE_BODY_hello-skill_REV_1'))), 'Model-selected load must return verified content without a user command');
  assert.equal((await messages()).filter(m => m.customType === 'mcp-skills-catalog').length, 0, 'Transient catalog must not accumulate in history');
  const readsBeforeSearch = calls('resources/read').length;
  const search = await command("/mcp-skills search hello-skill");
  assert.match(search, /hello-skill/);
  assert.match(search, /mcp:\/\/fixture\/hello-skill\/SKILL\.md/);
  assert.equal(calls('resources/read').length, readsBeforeSearch, 'Search must not fetch additional files');
  assert.equal(calls("skills/get").length, 0, "Listed search must not eagerly fetch each skill");
  assert.ok(calls("skills/list").length >= 1, "Extension must request skills/list over the real connection");
  assert.match(await command("/mcp-skills search no-such-fixture-skill"), /No skills matched/i);

  const hello = await command("/mcp-skills load fixture hello-skill");
  assert.match(hello, /FIXTURE_BODY_hello-skill_REV_1/);
  assert.match(hello, /fixture/);
  assert.equal(calls("resources/read", uri("hello-skill")).length, 1);
  const helloAgain = await command("/mcp-skills load fixture hello-skill");
  assert.match(helloAgain, /FIXTURE_BODY_hello-skill_REV_1/);
  assert.equal(calls("resources/read", uri("hello-skill")).length, 1, "Identical digest should reuse verified in-memory bytes");

  const hidden = await command(`/mcp-skills load fixture ${uri("hidden-skill")}`);
  assert.match(hidden, /FIXTURE_BODY_hidden-skill_REV_1/);
  assert.equal(calls("skills/get", uri("hidden-skill")).length, 1, "URI omitted from skills/list must use skills/get");

  const denied = await command("/mcp-skills load fixture bad-digest");
  assert.match(denied, /does not match the digest or size/i);
  assert.doesNotMatch(denied, /TAMPERED_BYTES_MUST_NEVER_BE_PRESENTED/);
  assert.equal(calls("skills/get", uri("bad-digest")).length, 1, "Digest mismatch must revalidate the manifest");

  const changed = await command("/mcp-skills load fixture changed-skill");
  assert.match(changed, /no longer matches the approved skill/i);
  assert.doesNotMatch(changed, /FIXTURE_BODY_changed-skill_REV_2/);
  const changedApproved = await command("/mcp-skills load fixture changed-skill");
  assert.match(changedApproved, /FIXTURE_BODY_changed-skill_REV_2/);
  assert.equal(calls("resources/read", uri("changed-skill")).length, 2, "Changed digest needs a new explicit load");
  assert.equal(calls("resources/read").filter((event) => event.params.uri.endsWith("notes.txt")).length, 0, "Supporting resources must remain lazy");

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
