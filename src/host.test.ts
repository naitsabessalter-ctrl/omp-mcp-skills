import { test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { SkillsHost } from "./host.ts";
import { EXTENSION_ID, sha256, utf8, type McpPort, type Skill } from "./model.ts";

const uri = "skill://example/SKILL.md";
const frontmatter = { name: "example", description: "A workflow" };
const text = "---\nname: example\ndescription: A workflow\n---\nContent.\n";
const entry: Skill = { uri, frontmatter, resources: [{ uri, digest: sha256(utf8(text)), size: utf8(text).length }] };
const cache = { resultType: "complete", ttlMs: 30_000, cacheScope: "private" };

function port(request: McpPort["request"], listeners = new Map<string, (params: unknown) => void>()): McpPort {
  return {
    request,
    capabilities: () => ({ resources: {}, extensions: { [EXTENSION_ID]: {} } }),
    instructions: () => undefined,
    protocolVersion: () => "2026-07-28",
    onNotification: (method, listener) => {
      listeners.set(method, listener);
      return () => { listeners.delete(method); };
    },
  };
}

async function session(request: McpPort["request"]): Promise<SkillsHost> {
  const host = new SkillsHost();
  await host.attach("origin", port(request));
  return host;
}

test("native read returns raw verified text without approval, activation, or execution", async () => {
  const calls: string[] = [];
  const host = await session(async (method) => {
    calls.push(method);
    if (method === "skills/list") return { ...cache, skills: [entry] };
    if (method === "resources/read") return { contents: [{ uri, text }] };
    throw new Error(`Unexpected method ${method}`);
  });
  expect(await host.readFile("origin", uri, "SKILL.md")).toEqual({ content: text, contentType: "text/markdown" });
  expect(await host.readFile("origin", uri, "")).toEqual({ content: text, contentType: "text/markdown" });
  expect(calls).toEqual(["skills/list", "resources/read"]);
  expect("load" in host).toBe(false);
  expect("acting" in host).toBe(false);
});

test("lookup by unlisted URI rejects substitution before fetching files", async () => {
  const calls: string[] = [];
  const host = await session(async (method) => {
    calls.push(method);
    return method === "skills/list" ? { ...cache, skills: [] } : { ...cache, skill: entry };
  });
  await expect(host.readFile("origin", "skill://other/SKILL.md", "SKILL.md")).rejects.toThrow("different URI");
  expect(calls).toEqual(["skills/list", "skills/get"]);
});

test("unlisted skills can be fetched by URI without advertising them", async () => {
  const host = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [] };
    if (method === "skills/get") return { ...cache, skill: entry };
    return { contents: [{ uri, text }] };
  });
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(text);
  expect(host.catalog()).toEqual([]);
});

test("matching bytes at another URI cannot satisfy a read", async () => {
  const host = await session(async (method) => method === "skills/list"
    ? { ...cache, skills: [entry] }
    : { contents: [{ uri: "skill://other/SKILL.md", text }] });
  await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow("no contents");
});

test("supporting UTF-8 and binary files retain content, MIME, escaping, and cache isolation", async () => {
  const reference = "skill://example/references/foo%20bar.md";
  const image = "skill://example/assets/image.bin";
  const referenceText = "Reference — привет";
  const binary = Buffer.from([0, 255, 128, 1]);
  const skill: Skill = { ...entry, resources: [
    ...(entry.resources as Exclude<Skill["resources"], string>),
    { uri: reference, digest: sha256(utf8(referenceText)), size: utf8(referenceText).length },
    { uri: image, digest: sha256(binary), size: binary.length },
  ] };
  const reads: string[] = [];
  const host = await session(async (method, params) => {
    if (method === "skills/list") return { ...cache, skills: [skill] };
    const target = String(params?.uri);
    reads.push(target);
    if (target === uri) return { contents: [{ uri, blob: Buffer.from(text).toString("base64"), mimeType: "text/markdown" }] };
    if (target === reference) return { contents: [{ uri: reference, blob: Buffer.from(referenceText).toString("base64"), mimeType: "text/markdown" }] };
    return { contents: [{ uri: image, blob: binary.toString("base64"), mimeType: "application/octet-stream" }] };
  });
  expect(await host.readFile("origin", uri, "references/deeper/../foo%20bar.md")).toEqual({ content: referenceText, contentType: "text/markdown" });
  const first = await host.readFile("origin", uri, "assets/image.bin");
  expect(first).toEqual({ content: binary, contentType: "application/octet-stream" });
  expect(Buffer.isBuffer(first.content)).toBe(true);
  (first.content as Buffer)[0] = 42;
  expect((await host.readFile("origin", uri, "assets/image.bin")).content).toEqual(binary);
  expect(reads).toEqual([uri, reference, image]);
});

test("nested SKILL.md is supporting content, not an independently activated entry", async () => {
  const nested = "skill://example/nested/SKILL.md";
  const nestedText = "This file deliberately has no frontmatter.";
  const skill: Skill = { ...entry, resources: [
    ...(entry.resources as Exclude<Skill["resources"], string>),
    { uri: nested, digest: sha256(utf8(nestedText)), size: utf8(nestedText).length },
  ] };
  const host = await session(async (method, params) => method === "skills/list" ? { ...cache, skills: [skill] }
    : { contents: [{ uri: params?.uri, text: params?.uri === uri ? text : nestedText }] });
  expect((await host.readFile("origin", uri, "nested/SKILL.md")).content).toBe(nestedText);
});

test("unsafe relative paths and encoded traversal never reach the MCP server", async () => {
  const calls: string[] = [];
  const host = await session(async (method) => { calls.push(method); return { ...cache, skills: [entry] }; });
  for (const path of ["../secret", "%2e%2e/secret", "references/%2fsecret", "references/%5csecret", "references/%00secret", "/secret", "\\secret", "skill://other/SKILL.md", "SKILL.md?secret", "%zz"]) {
    await expect(host.readFile("origin", uri, path)).rejects.toThrow("escapes");
  }
  expect(calls).toEqual(["skills/list"]);
});

test("changed digest refreshes metadata and re-fetches bytes automatically", async () => {
  const updated = `${text}REV_2\n`;
  const updatedEntry: Skill = { ...entry, resources: [{ uri, digest: sha256(utf8(updated)), size: utf8(updated).length }] };
  const calls: string[] = [];
  const host = await session(async (method) => {
    calls.push(method);
    if (method === "skills/list") return { ...cache, skills: [entry] };
    if (method === "skills/get") return { ...cache, skill: updatedEntry };
    return { contents: [{ uri, text: updated }] };
  });
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(updated);
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(updated);
  expect(calls).toEqual(["skills/list", "resources/read", "skills/get", "resources/read"]);
});

test("refreshed manifest never retroactively blesses bytes from the failed read", async () => {
  const updated = `${text}REV_2\n`;
  const updatedEntry: Skill = { ...entry, resources: [{ uri, digest: sha256(utf8(updated)), size: utf8(updated).length }] };
  let reads = 0;
  const host = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [entry] };
    if (method === "skills/get") return { ...cache, skill: updatedEntry };
    return { contents: [{ uri, text: ++reads === 1 ? updated : `${updated}unverified` }] };
  });
  await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow("digest or size");
  expect(reads).toBe(2);
});

test("stable digest mismatch and frontmatter mismatch are rejected", async () => {
  for (const skill of [entry, { ...entry, frontmatter: { ...frontmatter, description: "Different metadata" } }]) {
    const host = await session(async (method) => {
      if (method === "skills/list") return { ...cache, skills: [skill] };
      if (method === "skills/get") return { ...cache, skill };
      return { contents: [{ uri, text: skill === entry ? `${text}bad` : text }] };
    });
    await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow(skill === entry ? "digest or size" : "Frontmatter");
  }
});

test("expired metadata re-fetches both manifest and bytes, including ttlMs zero", async () => {
  const calls: string[] = [];
  const host = await session(async (method) => {
    calls.push(method);
    if (method === "skills/list") return { ...cache, ttlMs: 0, skills: [entry] };
    if (method === "skills/get") return { ...cache, ttlMs: 0, skill: entry };
    return { contents: [{ uri, text }] };
  });
  await host.readFile("origin", uri, "SKILL.md");
  await host.readFile("origin", uri, "SKILL.md");
  expect(calls).toEqual(["skills/list", "skills/get", "resources/read", "skills/get", "resources/read"]);
});

test("expired list TTL discovers new cloud skills without notifications", async () => {
  let lists = 0;
  const host = await session(async () => ({ ...cache, ttlMs: ++lists === 1 ? 0 : 30_000, skills: lists === 1 ? [] : [entry] }));
  expect(host.catalog()).toEqual([]);
  await host.refreshStaleCatalog();
  await host.refreshStaleCatalog();
  expect(host.catalog().map(({ skill }) => skill.uri)).toEqual([uri]);
  expect(lists).toBe(2);
});

test("dynamic skills fetch every read without approvals or cached bytes", async () => {
  let reads = 0;
  const host = await session(async (method) => method === "skills/list"
    ? { ...cache, skills: [{ ...entry, resources: "dynamic" }] }
    : { contents: [{ uri, text: `${text}${++reads}` }] });
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(`${text}1`);
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(`${text}2`);
});

test("read bytes and catalog are isolated by server even for identical URIs", async () => {
  const host = new SkillsHost();
  const otherText = `${text}Other origin\n`;
  const otherEntry: Skill = { ...entry, resources: [{ uri, digest: sha256(utf8(otherText)), size: utf8(otherText).length }] };
  await host.attach("origin", port(async (method) => method === "skills/list" ? { ...cache, skills: [entry] } : { contents: [{ uri, text }] }));
  await host.attach("other", port(async (method) => method === "skills/list" ? { ...cache, skills: [otherEntry] } : { contents: [{ uri, text: otherText }] }));
  expect((await host.readFile("origin", uri, "SKILL.md")).content).toBe(text);
  expect((await host.readFile("other", uri, "SKILL.md")).content).toBe(otherText);
  host.detach("origin");
  await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow("not a connected");
  expect((await host.readFile("other", uri, "SKILL.md")).content).toBe(otherText);
  host.clear();
  expect(host.catalog()).toEqual([]);
});

test("disconnect during awaited read rejects old bytes and reconnect starts uncached", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const host = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [entry] };
    started.resolve();
    return response.promise;
  });
  const pending = host.readFile("origin", uri, "SKILL.md");
  await started.promise;
  host.detach("origin");
  let reads = 0;
  await host.attach("origin", port(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [entry] };
    reads++;
    return { contents: [{ uri, text }] };
  }));
  response.resolve({ contents: [{ uri, text }] });
  await expect(pending).rejects.toThrow("Connection");
  await host.readFile("origin", uri, "SKILL.md");
  expect(reads).toBe(1);
});

test("list invalidation during awaited resource fetch rejects the stale snapshot", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const listeners = new Map<string, (params: unknown) => void>();
  const host = new SkillsHost();
  await host.attach("origin", port(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [entry] };
    started.resolve();
    return response.promise;
  }, listeners));
  const pending = host.readFile("origin", uri, "SKILL.md");
  await started.promise;
  listeners.get("notifications/skills/list_changed")?.({});
  response.resolve({ contents: [{ uri, text }] });
  await expect(pending).rejects.toThrow("metadata");
});

test("disconnect during skills/get cannot repopulate a detached catalog", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const host = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [] };
    started.resolve();
    return response.promise;
  });
  const pending = host.readFile("origin", uri, "SKILL.md");
  await started.promise;
  host.detach("origin");
  response.resolve({ ...cache, skill: entry });
  await expect(pending).rejects.toThrow("Connection");
  expect(host.catalog()).toEqual([]);
});

test("new supporting files refresh the manifest automatically and verify entry first", async () => {
  const supportingUri = "skill://example/references/new.md";
  const supportingText = "Fresh supporting content";
  const updatedEntry: Skill = { ...entry, resources: [
    ...(entry.resources as Exclude<Skill["resources"], string>),
    { uri: supportingUri, digest: sha256(utf8(supportingText)), size: utf8(supportingText).length },
  ] };
  const calls: string[] = [];
  const host = await session(async (method, params) => {
    calls.push(method === "resources/read" ? `${method}:${params?.uri}` : method);
    if (method === "skills/list") return { ...cache, skills: [entry] };
    if (method === "skills/get") return { ...cache, skill: updatedEntry };
    return { contents: [{ uri: params?.uri, text: params?.uri === uri ? text : supportingText }] };
  });
  expect((await host.readFile("origin", uri, "references/new.md")).content).toBe(supportingText);
  expect(calls).toEqual(["skills/list", `resources/read:${uri}`, "skills/get", `resources/read:${uri}`, `resources/read:${supportingUri}`]);
});

test("size mismatches, malformed base64 and invalid UTF-8 entry blobs are rejected", async () => {
  const wrongSize: Skill = { ...entry, resources: [{ uri, digest: sha256(utf8(text)), size: utf8(text).length + 1 }] };
  const sized = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [wrongSize] };
    if (method === "skills/get") return { ...cache, skill: wrongSize };
    return { contents: [{ uri, text }] };
  });
  await expect(sized.readFile("origin", uri, "SKILL.md")).rejects.toThrow("digest or size");
  for (const [blob, expected] of [["###", "invalid base64"], ["/w==", "not UTF-8"]]) {
    const host = await session(async (method) => method === "skills/list" ? { ...cache, skills: [{ ...entry, resources: "dynamic" }] }
      : { contents: [{ uri, blob }] });
    await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow(expected);
  }
});

test("a failed list invalidation discards cached bytes and metadata", async () => {
  let lists = 0;
  let gets = 0;
  const host = await session(async (method) => {
    if (method === "skills/list") {
      if (++lists > 1) throw new Error("offline list");
      return { ...cache, skills: [entry] };
    }
    if (method === "skills/get") { gets++; throw new Error("offline get"); }
    return { contents: [{ uri, text }] };
  });
  await host.readFile("origin", uri, "SKILL.md");
  await host.refresh("origin");
  expect(host.catalog()).toEqual([]);
  await expect(host.readFile("origin", uri, "SKILL.md")).rejects.toThrow("offline get");
  expect(gets).toBe(1);
});

test("a disconnected pending list cannot overwrite the replacement connection", async () => {
  const host = new SkillsHost();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const pending = host.attach("origin", port(async () => {
    started.resolve();
    return response.promise;
  }));
  await started.promise;
  await host.attach("origin", port(async () => ({ ...cache, skills: [] })));
  response.resolve({ ...cache, skills: [entry] });
  await pending;
  expect(host.catalog()).toEqual([]);
});

test("parallel reads of an unlisted skill share metadata lookup without rejecting each other", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  let gets = 0;
  const host = await session(async (method) => {
    if (method === "skills/list") return { ...cache, skills: [] };
    if (method === "skills/get") {
      gets++;
      started.resolve();
      return response.promise;
    }
    return { contents: [{ uri, text }] };
  });
  const first = host.readFile("origin", uri, "SKILL.md");
  await started.promise;
  const second = host.readFile("origin", uri, "SKILL.md");
  response.resolve({ ...cache, skill: entry });
  const files = await Promise.all([first, second]);
  expect(files.map((file) => file.content)).toEqual([text, text]);
  expect(gets).toBe(1);
});
