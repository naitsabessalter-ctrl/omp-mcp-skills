import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp';
import { AgentRegistry, type AgentRef } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { BroadcastChannel } from 'node:worker_threads';
import { isRecord } from './model.ts';

export interface ChildCatalogEntry {
  server: string;
  name: string;
  path: string;
  description: string;
}

type SkillFile = {content: string | Buffer; contentType: string};
type ChildSource = {
  catalog(): Promise<ChildCatalogEntry[]>;
  readFile(server: string, uri: string, relative: string): Promise<SkillFile>;
};
type ChildSkills = ChildSource & {close(): void};
type Operation = {kind: 'catalog'} | {kind: 'read'; server: string; uri: string; relative: string};
type Request = Operation & {id: string; key: string; sessionId: string; generation: number; nonce: string};
type WireFile = {content: string | Uint8Array; contentType: string};
type Reply = {kind: 'accepted'} | {kind: 'catalog'; entries: ChildCatalogEntry[]} |
  {kind: 'file'; file: WireFile} | {kind: 'error'; message: string};
type Result = ChildCatalogEntry[] | SkillFile;

const UNAVAILABLE = 'No remote skill host for the calling subagent';
const FORBIDDEN = 'MCP skill server is not available to the calling subagent';
const REQUEST_PREFIX = 'omp-mcp-skills-child-v1';
const ACCEPT_TIMEOUT_MS = 1_000;

function requestTopic(rootKey: string): string {
  return `${REQUEST_PREFIX}:${rootKey}`;
}

function replyTopic(rootKey: string, key: string, nonce: string): string {
  return `${requestTopic(rootKey)}:reply:${key}:${nonce}`;
}

function liveSession(ref: AgentRef | undefined, id: string, key?: string): ref is AgentRef & {session: NonNullable<AgentRef['session']>} {
  return !!ref?.session && (key === undefined || ref.session.instanceKey === key) &&
    ref.session.sessionManager.getSessionId() === id;
}

function restricted(ref: AgentRef | undefined): boolean {
  const session = ref?.session;
  return !!session && 'restrictToolNames' in session && session.restrictToolNames === true;
}

// Registry names are reusable; require the actual session instance at every edge.
function rootOf(ref: AgentRef | undefined): AgentRef | undefined {
  const registry = AgentRegistry.global();
  const seen = new Set<string>();
  while (ref?.kind === 'sub' && ref.session && ref.parentId && ref.parentSessionKey) {
    if (seen.has(ref.session.instanceKey)) return;
    seen.add(ref.session.instanceKey);
    const parent = registry.get(ref.parentId);
    if (parent?.session?.instanceKey !== ref.parentSessionKey) return;
    ref = parent;
  }
  return ref?.kind === 'main' && ref.session ? ref : undefined;
}

function requestFrom(value: unknown): Request | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.key !== 'string' ||
      typeof value.sessionId !== 'string' || typeof value.generation !== 'number' ||
      typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(value.nonce)) return;
  if (value.kind === 'catalog' || (value.kind === 'read' && typeof value.server === 'string' &&
      typeof value.uri === 'string' && typeof value.relative === 'string')) return value as Request;
}

function visibleConnection(manager: MCPManager, server: string, tools: ReadonlyArray<{mcpServerName?: string}>) {
  const connection = manager.getConnection(server);
  if (!connection?.transport.connected) return;
  // An unknown inventory is not proof of a skills-only server.
  if (connection.capabilities.tools === undefined || connection.tools?.length === 0 ||
      tools.some(tool => tool.mcpServerName === server)) return connection;
}

/** Serve from the owning root's existing cache and transports, never from a worker proxy. */
export function bindChildHost(pi: ExtensionAPI, ctx: ExtensionContext, source: ChildSource): () => void {
  const id = ctx.sessionManager.getSessionId();
  const registry = AgentRegistry.global();
  const root = registry.get(ctx.agent.id);
  const manager = MCPManager.instance();
  if (ctx.agent.kind !== 'main' || root?.kind !== 'main' || !liveSession(root, id) || restricted(root) ||
      !(manager instanceof MCPManager)) return () => {};
  const key = root.session.instanceKey;
  const generation = root.generation;
  // Only a root-specific request channel is shared. Skill content goes to a fresh private reply topic.
  const endpoint = new BroadcastChannel(requestTopic(key));
  endpoint.unref();
  const pending = new Set<(reply: Reply) => void>();
  let closed = false;

  function authorized(request: Request): boolean {
    const owner = registry.get(ctx.agent.id);
    if (closed || MCPManager.instance() !== manager || owner?.generation !== generation || !liveSession(owner, id, key)) return false;
    const child = registry.get(request.id);
    return child?.kind === 'sub' && child.generation === request.generation &&
      liveSession(child, request.sessionId, request.key) && !restricted(child) &&
      rootOf(child)?.session?.instanceKey === key;
  }

  endpoint.onmessage = ({data}) => {
    const request = requestFrom(data);
    if (!request) return;
    void serve(request).catch(error => pi.logger.debug('MCP skill bridge failed', {error: String(error)}));
  };

  async function serve(request: Request): Promise<void> {
    if (!authorized(request)) return;
    const reply = new BroadcastChannel(replyTopic(key, request.key, request.nonce));
    const finish = (result: Reply) => {
      if (!pending.delete(finish)) return;
      try { reply.postMessage(result); } finally { reply.close(); }
    };
    pending.add(finish);
    try {
      reply.postMessage({kind: 'accepted'} satisfies Reply);
      if (request.kind === 'catalog') {
        const entries = await source.catalog();
        if (!authorized(request)) throw new Error(UNAVAILABLE);
        const tools = manager.getTools(request.sessionId);
        const permitted = new Map<string, boolean>();
        finish({kind: 'catalog', entries: entries.filter(({server}) => {
          let allowed = permitted.get(server);
          if (allowed === undefined) {
            allowed = visibleConnection(manager, server, tools) !== undefined;
            permitted.set(server, allowed);
          }
          return allowed;
        })});
        return;
      }
      const connection = visibleConnection(manager, request.server, manager.getTools(request.sessionId));
      if (!connection) throw new Error(FORBIDDEN);
      const file = await source.readFile(request.server, request.uri, request.relative);
      if (!authorized(request)) throw new Error(UNAVAILABLE);
      if (visibleConnection(manager, request.server, manager.getTools(request.sessionId)) !== connection) throw new Error(FORBIDDEN);
      finish({kind: 'file', file});
    } catch (error) {
      if (authorized(request)) {
        finish({kind: 'error', message: error instanceof Error ? error.message : String(error)});
      } else {
        finish({kind: 'error', message: UNAVAILABLE});
      }
    }
  }

  return () => {
    if (closed) return;
    closed = true;
    endpoint.close();
    for (const finish of pending) finish({kind: 'error', message: UNAVAILABLE});
  };
}

/** Bind a child reader to its actual live OMP session, including in worker threads. */
export function bindChildClient(_pi: ExtensionAPI, ctx: ExtensionContext): ChildSkills {
  const sessionId = ctx.sessionManager.getSessionId();
  const pending = new Set<() => void>();
  let closed = false;

  async function request(operation: Operation): Promise<Result> {
    if (closed || ctx.agent.kind !== 'sub' || ctx.sessionManager.getSessionId() !== sessionId) throw new Error(UNAVAILABLE);
    const child = AgentRegistry.global().get(ctx.agent.id);
    // The local session holds the SDK restriction flag even when main sees a worker mirror.
    if (!child?.session || !liveSession(child, sessionId) || !('restrictToolNames' in child.session) || restricted(child)) {
      throw new Error(UNAVAILABLE);
    }
    const rootKey = rootOf(child)?.session?.instanceKey;
    if (!rootKey) throw new Error(UNAVAILABLE);
    const key = child.session.instanceKey;
    const nonce = randomUUID();
    const reply = new BroadcastChannel(replyTopic(rootKey, key, nonce));
    const endpoint = new BroadcastChannel(requestTopic(rootKey));
    const {promise, resolve, reject} = Promise.withResolvers<Result>();
    const stop = () => finish(new Error(UNAVAILABLE));
    const deadline = setTimeout(stop, ACCEPT_TIMEOUT_MS);
    const finish = (result: Result | Error) => {
      if (!pending.delete(stop)) return;
      clearTimeout(deadline);
      reply.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    pending.add(stop);
    reply.onmessage = ({data}: {data: Reply}) => {
      if (data?.kind === 'accepted') clearTimeout(deadline);
      else if (data?.kind === 'error') finish(new Error(data.message));
      else if (operation.kind === 'catalog' && data?.kind === 'catalog') finish(data.entries);
      else if (operation.kind === 'read' && data?.kind === 'file') {
        const {content, contentType} = data.file;
        finish({content: typeof content === 'string' ? content : Buffer.from(content.buffer, content.byteOffset, content.byteLength), contentType});
      }
    };
    reply.onmessageerror = stop;
    try {
      endpoint.postMessage({...operation, id: child.id, key, sessionId, generation: child.generation, nonce} satisfies Request);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    } finally {
      endpoint.close();
    }
    return promise;
  }

  return {
    async catalog() { return await request({kind: 'catalog'}) as ChildCatalogEntry[]; },
    async readFile(server, uri, relative) { return await request({kind: 'read', server, uri, relative}) as SkillFile; },
    close() {
      closed = true;
      for (const stop of pending) stop();
    },
  };
}
