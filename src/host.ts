import { Buffer } from "node:buffer";
import {
  EXTENSION_ID,
  MAX_SKILL_BYTES,
  type McpPort,
  type Skill,
  SkillsFailure,
  decodeResource,
  displayNameFor,
  extensionSettings,
  instructionSkillUris,
  parseFrontmatter,
  parseGetResult,
  parseListResult,
  parseSkill,
  resolveReference,
  rpcFailure,
  sameValue,
  sha256,
  validateSkill,
} from "./model.ts";

export interface CatalogEntry {
  server: string;
  skill: Skill;
  displayName: string;
  directoryRead: boolean;
  ttlMs?: number;
  cacheScope?: string;
  fetchedAt: number;
  fromGet: boolean;
}

export interface RejectedEntry {
  server: string;
  uri?: string;
  reason: string;
}

export interface ReferenceEntry {
  server: string;
  uri: string;
}

interface VerifiedFile {
  bytes: Uint8Array;
  text?: string;
  mimeType?: string;
}

interface Snapshot {
  skill: Skill;
  fetchedAt: number;
  ttlMs?: number;
  cacheScope?: string;
  fromGet: boolean;
  files: Map<string, VerifiedFile>;
  dynamicSizes: Map<string, number>;
}

interface ServerState {
  port: McpPort;
  protocolVersion: string | undefined;
  directoryRead: boolean;
  instructions: string | undefined;
  entries: Map<string, Snapshot>;
  lookups: Map<string, { revision: number; promise: Promise<Snapshot> }>;
  rejected: RejectedEntry[];
  listError?: string;
  unsubs: (() => void)[];
  revision: number;
  listFreshUntil: number;
  refresh?: Promise<void>;
}

class IntegrityFailure extends SkillsFailure {}

const MAX_PAGES = 1_000;

/** Reads untrusted skill files through OMP's existing MCP connections; never executes them. */
export class SkillsHost {
  private readonly servers = new Map<string, ServerState>();

  async attach(server: string, port: McpPort): Promise<void> {
    this.detach(server);
    const settings = extensionSettings(port.capabilities());
    if (!settings.declared) return;
    const state: ServerState = {
      port,
      protocolVersion: port.protocolVersion(),
      directoryRead: settings.directoryRead,
      instructions: port.instructions(),
      entries: new Map(),
      lookups: new Map(),
      rejected: [],
      unsubs: [],
      revision: 0,
      listFreshUntil: 0,
    };
    this.servers.set(server, state);
    if (!settings.resources) {
      state.listError = `${server} declares ${EXTENSION_ID} but not the resources capability`;
      state.rejected.push({ server, reason: state.listError });
      return;
    }
    const changed = () => {
      if (this.servers.get(server) === state) void this.enqueueRefresh(server, state);
    };
    state.unsubs.push(
      port.onNotification("notifications/resources/list_changed", changed),
      port.onNotification("notifications/skills/list_changed", changed),
    );
    await this.enqueueRefresh(server, state);
  }

  detach(server: string): void {
    const state = this.servers.get(server);
    if (!state) return;
    this.servers.delete(server);
    state.entries.clear();
    for (const unsubscribe of state.unsubs) unsubscribe();
  }

  clear(): void {
    for (const server of this.servers.keys()) this.detach(server);
  }

  async refresh(server?: string): Promise<void> {
    const names = server === undefined ? [...this.servers.keys()] : [server];
    await Promise.all(names.map((name) => {
      const state = this.servers.get(name);
      return state ? this.enqueueRefresh(name, state) : Promise.resolve();
    }));
  }

  async refreshStaleCatalog(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.servers].map(([server, state]) => {
      if (!extensionSettings(state.port.capabilities()).resources || now < state.listFreshUntil) return Promise.resolve();
      return state.refresh ?? this.enqueueRefresh(server, state);
    }));
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  catalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const [server, state] of this.servers) {
      const listed = [...state.entries.values()].filter(entry => !entry.fromGet);
      const siblings = listed.map(entry => entry.skill);
      for (const entry of listed) {
        entries.push({
          server,
          skill: entry.skill,
          displayName: displayNameFor(entry.skill, siblings),
          directoryRead: state.directoryRead,
          fetchedAt: entry.fetchedAt,
          fromGet: entry.fromGet,
          ...(entry.ttlMs === undefined ? {} : { ttlMs: entry.ttlMs }),
          ...(entry.cacheScope === undefined ? {} : { cacheScope: entry.cacheScope }),
        });
      }
    }
    return entries;
  }

  rejected(): RejectedEntry[] {
    return [...this.servers.values()].flatMap((state) => state.rejected);
  }

  references(server?: string): ReferenceEntry[] {
    const references: ReferenceEntry[] = [];
    for (const [name, state] of this.servers) {
      if (server !== undefined && name !== server) continue;
      for (const uri of instructionSkillUris(state.instructions)) {
        if (!state.entries.has(uri)) references.push({ server: name, uri });
      }
    }
    return references;
  }

  errors(): { server: string; message: string }[] {
    return [...this.servers].flatMap(([server, state]) => state.listError ? [{ server, message: state.listError }] : []);
  }

  /**
   * Native OMP resolver API. Paths are relative to the original SKILL.md root and retain URI
   * escaping. Reads require no skill-specific approval and confer no execution permission.
   */
  async readFile(server: string, skillUri: string, relativePath: string): Promise<{ content: string | Buffer; contentType: string }> {
    const state = this.requireServer(server);
    const uri = resolveReference(skillUri, relativePath || "SKILL.md");
    if (!uri) throw new SkillsFailure(`${relativePath} escapes the skill root of ${skillUri}`);
    if (state.refresh) await state.refresh;
    this.assertCurrent(server, state);
    let snapshot = state.entries.get(skillUri);
    if (!snapshot || !this.fresh(snapshot)) snapshot = await this.getSkill(server, state, skillUri);
    for (let attempt = 0; ; attempt++) {
      const revision = state.revision;
      try {
        // Supporting files do not activate nested skills, but their owning entry must be genuine.
        const entry = await this.fetchVerified(server, state, snapshot, skillUri, revision);
        this.assertSnapshot(server, state, snapshot, revision);
        const file = uri === skillUri ? entry : await this.fetchVerified(server, state, snapshot, uri, revision);
        this.assertSnapshot(server, state, snapshot, revision);
        return {
          content: file.text ?? Buffer.from(file.bytes),
          contentType: file.mimeType ?? (file.text === undefined ? "application/octet-stream" : uri.endsWith(".md") ? "text/markdown" : "text/plain"),
        };
      } catch (error) {
        this.assertSnapshot(server, state, snapshot, revision);
        if (!(error instanceof IntegrityFailure) || attempt !== 0) throw error;
        // Never bless the failed read using a new manifest: fetch and verify the bytes again.
        snapshot.files.clear();
        snapshot = await this.getSkill(server, state, skillUri);
      }
    }
  }

  private requireServer(server: string): ServerState {
    const state = this.servers.get(server);
    if (!state) throw new SkillsFailure(`${server} is not a connected skills server`);
    if (!extensionSettings(state.port.capabilities()).resources) throw new SkillsFailure(state.listError ?? `${server} has no resources capability`);
    return state;
  }

  private assertCurrent(server: string, state: ServerState, revision?: number): void {
    if (this.servers.get(server) !== state) throw new SkillsFailure(`Connection to ${server} changed during read`);
    if (revision !== undefined && state.revision !== revision) throw new SkillsFailure(`Skill metadata on ${server} changed during read`);
  }

  private assertSnapshot(server: string, state: ServerState, snapshot: Snapshot, revision: number): void {
    this.assertCurrent(server, state, revision);
    if (state.entries.get(snapshot.skill.uri) !== snapshot) throw new SkillsFailure(`Skill metadata on ${server} changed during read`);
  }

  private fresh(snapshot: Snapshot): boolean {
    return snapshot.ttlMs === undefined || Date.now() - snapshot.fetchedAt < snapshot.ttlMs;
  }

  private getSkill(server: string, state: ServerState, uri: string): Promise<Snapshot> {
    const existing = state.lookups.get(uri);
    if (existing?.revision === state.revision) return existing.promise;
    const lookup = { revision: state.revision, promise: this.pullSkill(server, state, uri) };
    state.lookups.set(uri, lookup);
    const clear = () => {
      if (state.lookups.get(uri) === lookup) state.lookups.delete(uri);
    };
    void lookup.promise.then(clear, clear);
    return lookup.promise;
  }

  private async pullSkill(server: string, state: ServerState, uri: string): Promise<Snapshot> {
    const revision = state.revision;
    const previous = state.entries.get(uri);
    let result: unknown;
    try {
      result = await state.port.request("skills/get", { uri });
    } catch (error) {
      this.assertCurrent(server, state, revision);
      throw rpcFailure(error);
    }
    this.assertCurrent(server, state, revision);
    if (state.entries.get(uri) !== previous) throw new SkillsFailure(`Skill metadata on ${server} changed during lookup`);
    const parsed = parseGetResult(result, state.protocolVersion);
    if ("error" in parsed) throw new SkillsFailure(parsed.error);
    const entry = parseSkill(parsed.skill);
    if ("error" in entry) throw new SkillsFailure(entry.error);
    if (entry.skill.uri !== uri) throw new SkillsFailure(`skills/get returned a different URI than ${uri}`);
    const verdict = validateSkill(entry.skill);
    if (!verdict.ok) throw new SkillsFailure(verdict.reason);
    const snapshot = this.snapshot(entry.skill, parsed, previous?.fromGet ?? true);
    state.entries.set(uri, snapshot);
    return snapshot;
  }

  private async fetchVerified(server: string, state: ServerState, snapshot: Snapshot, uri: string, revision: number): Promise<VerifiedFile> {
    this.assertSnapshot(server, state, snapshot, revision);
    const skill = snapshot.skill;
    const listed = skill.resources === "dynamic" ? undefined : skill.resources.find((resource) => resource.uri === uri);
    if (skill.resources !== "dynamic" && !listed) throw new IntegrityFailure(`${uri} is not listed in ${skill.uri}`);
    const cached = listed ? snapshot.files.get(uri) : undefined;
    if (cached && bytesMatch(cached.bytes, listed!)) return cached;
    let result: unknown;
    try {
      result = await state.port.request("resources/read", { uri });
    } catch (error) {
      this.assertSnapshot(server, state, snapshot, revision);
      throw rpcFailure(error);
    }
    this.assertSnapshot(server, state, snapshot, revision);
    const decoded = decodeResource(result, uri);
    if ("error" in decoded) throw new SkillsFailure(decoded.error);
    if (decoded.bytes.byteLength > MAX_SKILL_BYTES) throw new SkillsFailure(`${uri} exceeds the ${MAX_SKILL_BYTES} byte limit`);
    if (listed && !bytesMatch(decoded.bytes, listed)) throw new IntegrityFailure(`${uri} on ${server} does not match the digest or size in the skill entry`);
    if (uri === skill.uri) {
      const frontmatter = parseFrontmatter(decoded.text ?? "");
      if ("error" in frontmatter) throw new IntegrityFailure(frontmatter.error);
      if (!sameValue(frontmatter.value, skill.frontmatter)) throw new IntegrityFailure(`Frontmatter of ${uri} does not match the skill entry from ${server}`);
    }
    if (skill.resources === "dynamic") {
      let total = decoded.bytes.byteLength;
      for (const [other, size] of snapshot.dynamicSizes) if (other !== uri) total += size;
      if (total > MAX_SKILL_BYTES) throw new SkillsFailure(`${skill.uri} on ${server} reached the ${MAX_SKILL_BYTES} byte limit for a dynamic skill`);
      snapshot.dynamicSizes.set(uri, decoded.bytes.byteLength);
    } else {
      snapshot.files.set(uri, decoded);
    }
    return decoded;
  }

  private snapshot(skill: Skill, cache: { ttlMs?: number; cacheScope?: string }, fromGet: boolean): Snapshot {
    return {
      skill,
      fetchedAt: Date.now(),
      ...(cache.ttlMs === undefined ? {} : { ttlMs: cache.ttlMs }),
      ...(cache.cacheScope === undefined ? {} : { cacheScope: cache.cacheScope }),
      fromGet,
      files: new Map(),
      dynamicSizes: new Map(),
    };
  }

  private enqueueRefresh(server: string, state: ServerState): Promise<void> {
    state.revision++;
    if (state.refresh) return state.refresh;
    const pending = this.pullUntilCurrent(server, state);
    state.refresh = pending;
    void pending.finally(() => { if (state.refresh === pending) state.refresh = undefined; });
    return pending;
  }

  private async pullUntilCurrent(server: string, state: ServerState): Promise<void> {
    do {
      const revision = state.revision;
      await this.pullList(server, state, revision);
      if (this.servers.get(server) !== state || state.revision === revision) return;
    } while (true);
  }

  private async pullList(server: string, state: ServerState, revision: number): Promise<void> {
    const entries = new Map<string, Snapshot>();
    const rejected: RejectedEntry[] = [];
    let cursor: string | undefined;
    let cache: { ttlMs?: number; cacheScope?: string } = {};
    const seen = new Set<string>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await state.port.request("skills/list", cursor ? { cursor } : {});
        this.assertCurrent(server, state, revision);
        const parsed = parseListResult(result, state.protocolVersion);
        if ("error" in parsed) throw new SkillsFailure(parsed.error);
        if (page === 0) cache = { ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }), ...(parsed.cacheScope === undefined ? {} : { cacheScope: parsed.cacheScope }) };
        for (const item of parsed.skills) {
          const parsedSkill = parseSkill(item);
          if ("error" in parsedSkill) {
            rejected.push({ server, reason: parsedSkill.error });
            continue;
          }
          const skill = parsedSkill.skill;
          const verdict = validateSkill(skill);
          if (!verdict.ok) rejected.push({ server, uri: skill.uri, reason: verdict.reason });
          else if (entries.has(skill.uri)) throw new SkillsFailure(`skills/list repeats ${skill.uri}`);
          else entries.set(skill.uri, this.snapshot(skill, cache, false));
        }
        if (!parsed.nextCursor) break;
        if (seen.has(parsed.nextCursor)) throw new SkillsFailure("skills/list repeated nextCursor");
        seen.add(parsed.nextCursor);
        if (page + 1 === MAX_PAGES) throw new SkillsFailure("skills/list exceeded the page limit");
        cursor = parsed.nextCursor;
      }
    } catch (error) {
      if (this.servers.get(server) === state && state.revision === revision) {
        state.listError = rpcFailure(error).message;
        // Failed invalidations cannot leave previously cached metadata or bytes readable.
        state.entries.clear();
      }
      return;
    }
    this.assertCurrent(server, state, revision);
    state.entries = entries;
    state.listFreshUntil = cache.ttlMs === undefined ? Infinity : Date.now() + cache.ttlMs;
    state.rejected = rejected;
    state.listError = undefined;
  }
}

function bytesMatch(bytes: Uint8Array, listed: { digest: string; size: number }): boolean {
  return bytes.byteLength === listed.size && sha256(bytes) === listed.digest;
}
