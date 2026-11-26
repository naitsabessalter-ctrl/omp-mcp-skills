import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as MCPRuntime from "@oh-my-pi/pi-coding-agent/mcp";
import type { SkillsHost } from "./host.ts";
import { CACHE_PROTOCOL, clientCapabilitiesWithSkills, isRecord, type McpPort } from "./model.ts";

/** Public live connection returned by OMP's MCPManager.getConnection(). */
export interface LiveMCPConnection {
  transport: {
    request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
    readonly connected: boolean;
  };
  capabilities: object;
  instructions?: string;
  roots?(): Array<{ uri: string; name?: string }>;
}

/** A real, local MCPManager; worker-thread proxies intentionally do not expose raw transports. */
export interface LiveMCPManager {
  getConnectedServers(): string[];
  getConnection(name: string): LiveMCPConnection | undefined;
  getConnectionStatus?(name: string): "connected" | "connecting" | "disconnected";
  waitForPendingConnections?(): Promise<void>;
  addNotificationListener(listener: (server: string, method: string, params: unknown) => void): () => void;
}

export interface BindingOptions {
  /** SDK embedders may supply their own manager, including MCPLoadResult.manager, without reloading it. */
  manager?: LiveMCPManager | ((ctx: ExtensionContext) => LiveMCPManager | undefined | Promise<LiveMCPManager | undefined>);
  /** SDK/test injection: pass the host's MCP_CLIENT_CAPABILITIES, not a copy. Defaults to OMP's bundled export. */
  clientCapabilities?: Record<string, unknown>;
}

export interface SkillsBinding {
  /** Resolve and synchronize OMP's live connections before a skill tool or command runs. */
  sync(ctx: ExtensionContext): Promise<void>;
  /** Deliver an incoming server notification; does not send a notification to the server. */
  notify(server: string, method: string, params: unknown): void;
  /** Release only this binding's state and listeners. The owning OMP session keeps its transports. */
  close(): void;
  readonly gap: string | undefined;
}

type Listener = (params: unknown) => void;
type Snapshot = { connection: LiveMCPConnection; capabilities: object; instructions: string | undefined };
type CapabilityLease = { count: number; previous: unknown; installed: unknown; hadOwn: boolean };

// Extension reloads can evaluate another module instance while the previous session is shutting down.
const LEASES = Symbol.for("omp-mcp-skills.capability-leases");
const shared = globalThis as typeof globalThis & { [LEASES]?: WeakMap<object, CapabilityLease> };
const capabilityLeases = shared[LEASES] ??= new WeakMap<object, CapabilityLease>();

function advertise(capabilities: Record<string, unknown>): () => void {
  let lease = capabilityLeases.get(capabilities);
  if (!lease) {
    const installed = clientCapabilitiesWithSkills(capabilities).extensions;
    lease = { count: 0, previous: capabilities.extensions, installed, hadOwn: Object.hasOwn(capabilities, "extensions") };
    capabilities.extensions = installed;
    capabilityLeases.set(capabilities, lease);
  }
  lease.count++;
  return () => {
    if (--lease.count !== 0) return;
    if (capabilities.extensions === lease.installed) {
      if (lease.hadOwn) capabilities.extensions = lease.previous;
      else delete capabilities.extensions;
    }
    capabilityLeases.delete(capabilities);
  };
}

function isLiveManager(value: unknown): value is LiveMCPManager {
  return typeof value === "object" && value !== null &&
    "getConnection" in value && typeof value.getConnection === "function" &&
    "getConnectedServers" in value && typeof value.getConnectedServers === "function" &&
    "addNotificationListener" in value && typeof value.addNotificationListener === "function";
}

/**
 * Reuse the exact HostLinks OMP owns, including stdio; never spawn or initialize another client.
 * Canonical package imports are rewritten by OMP 19.2.1 to its own bundled module instances.
 * MCP 2026-07-28 advertises capabilities on every request, not through initialize.
 */
export function createBinding(host: SkillsHost, options: BindingOptions = {}): SkillsBinding {
  const snapshots = new Map<string, Snapshot>();
  const listeners = new Map<string, Map<string, Set<Listener>>>();
  const controller = new AbortController();
  let manager: LiveMCPManager | undefined;
  let offNotifications: (() => void) | undefined;
  let releaseCapabilities: (() => void) | undefined;
  let clientCapabilities: Record<string, unknown> | undefined;
  let runtime: Promise<typeof MCPRuntime> | undefined;
  let closed = false;
  let ownershipLost = false;
  let gap: string | undefined;
  let tail: Promise<void> = Promise.resolve();

  function notify(server: string, method: string, params: unknown): void {
    if (closed) return;
    for (const listener of listeners.get(server)?.get(method) ?? []) listener(params);
  }

  function detachAll(): void {
    for (const server of snapshots.keys()) host.detach(server);
    snapshots.clear();
    listeners.clear();
  }

  function hostRuntime(): Promise<typeof MCPRuntime> {
    // OMP-only module: absent in standalone SDK/test consumers that inject both host references.
    return runtime ??= import("@oh-my-pi/pi-coding-agent/mcp");
  }

  async function initialize(): Promise<void> {
    if (releaseCapabilities) return;
    let capabilities = options.clientCapabilities;
    if (!capabilities) {
      const protocol = await hostRuntime();
      if (protocol.MCP_PROTOCOL_VERSION !== CACHE_PROTOCOL) {
        throw new Error(`Unsupported OMP MCP revision: ${protocol.MCP_PROTOCOL_VERSION}`);
      }
      capabilities = protocol.MCP_CLIENT_CAPABILITIES as Record<string, unknown>;
    }
    if (closed) return;
    releaseCapabilities = advertise(capabilities);
    clientCapabilities = capabilities;
  }

  async function syncOnce(ctx: ExtensionContext): Promise<void> {
    if (closed) throw new Error("MCP skills binding is closed");
    if (ownershipLost) throw new Error(gap ?? "MCP skills connection ownership was lost");
    if (ctx.agent?.kind !== "main") {
      gap = "MCP skills require the owning top-level OMP session; subagent and restricted contexts cannot borrow raw MCP transports.";
      detachAll();
      throw new Error(gap);
    }
    let candidate: unknown;
    if (options.manager) {
      candidate = typeof options.manager === "function" ? await options.manager(ctx) : options.manager;
    } else {
      candidate = (await hostRuntime()).MCPManager.instance();
    }
    if (closed) return;
    if (candidate !== undefined && !isLiveManager(candidate)) {
      offNotifications?.();
      offNotifications = undefined;
      ownershipLost = manager !== undefined;
      detachAll();
      gap = "This OMP context exposes only an MCP worker proxy, not live transports. Bind on the owning session, or pass its local MCPManager and MCP_CLIENT_CAPABILITIES through createBinding(host, options).";
      throw new Error(gap);
    }
    if (manager && candidate !== manager) {
      ownershipLost = true;
      offNotifications?.();
      offNotifications = undefined;
      detachAll();
      gap = "OMP's process-global MCP manager changed. Refusing an ambiguous cross-session attachment; recreate the skills binding for the owning session.";
      throw new Error(gap);
    }
    if (!candidate) {
      gap = "No live OMP MCP manager is available. Enable MCP in the owning top-level session, or supply its local manager with createBinding(host, options).";
      throw new Error(gap);
    }
    await initialize();
    if (closed) return;
    gap = undefined;
    if (candidate !== manager) {
      offNotifications?.();
      offNotifications = undefined;
      detachAll();
      manager = candidate;
      offNotifications = manager?.addNotificationListener(notify);
    }
    const current = manager;
    if (!current) return;
    await current.waitForPendingConnections?.();
    if (closed) return;
    const names = new Set(current.getConnectedServers());
    for (const [server] of snapshots) {
      const connection = current.getConnection(server);
      if (!names.has(server) || !connection?.transport.connected || current.getConnectionStatus?.(server) === "disconnected") {
        host.detach(server);
        snapshots.delete(server);
        listeners.delete(server);
      }
    }
    const errors: unknown[] = [];
    await Promise.all([...names].map(async (server) => {
      const connection = current.getConnection(server);
      if (!connection?.transport.connected) return;
      const status = current.getConnectionStatus?.(server);
      if (status !== undefined && status !== "connected") return;
      const previous = snapshots.get(server);
      if (previous?.connection === connection && previous.capabilities === connection.capabilities && previous.instructions === connection.instructions) return;
      host.detach(server);
      snapshots.delete(server);
      listeners.delete(server);
      try {
        // Bypass a pre-extension discovery cache without changing OMP's memoized catalogs.
        const discover = await request(connection, "server/discover", { _meta: { "omp/cache": "no-store" } });
        if (!isRecord(discover) || !isRecord(discover.capabilities) ||
            (discover.resultType !== undefined && discover.resultType !== "complete") ||
            !Array.isArray(discover.supportedVersions) || !discover.supportedVersions.includes(CACHE_PROTOCOL)) {
          throw new Error(`MCP server ${server} returned an invalid ${CACHE_PROTOCOL} server/discover result`);
        }
        if (closed || current.getConnection(server) !== connection) return;
        const capabilities = discover.capabilities;
        const instructions = typeof discover.instructions === "string" ? discover.instructions : undefined;
        const port: McpPort = {
          request: (method, params) => request(connection, method, params),
          capabilities: () => capabilities,
          instructions: () => instructions,
          // The host presents modern protocol semantics even for legacy upstream transports.
          protocolVersion: () => CACHE_PROTOCOL,
          onNotification(method, listener) {
            let methods = listeners.get(server);
            if (!methods) listeners.set(server, methods = new Map());
            let subscribers = methods.get(method);
            if (!subscribers) methods.set(method, subscribers = new Set());
            subscribers.add(listener);
            return () => subscribers.delete(listener);
          },
        };
        snapshots.set(server, { connection, capabilities: connection.capabilities, instructions: connection.instructions });
        await host.attach(server, port);
        if (closed) host.detach(server);
      } catch (error) {
        host.detach(server);
        snapshots.delete(server);
        listeners.delete(server);
        if (!closed) errors.push(error);
      }
    }));
    if (errors.length) throw new AggregateError(errors, "Could not attach MCP skills to live OMP connections");
  }

  async function request(connection: LiveMCPConnection, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const meta = isRecord(params?._meta) ? params._meta : {};
    const original = {
      ...params,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/protocolVersion": CACHE_PROTOCOL,
        "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
      },
    };
    let attempt: Record<string, unknown> = original;
    for (let round = 0; round < 8; round++) {
      const result = await connection.transport.request(method, attempt, { signal: controller.signal });
      if (!isRecord(result)) throw new Error(`MCP ${method} returned a non-object result`);
      if (result.resultType === undefined || result.resultType === "complete") return result;
      if (result.resultType !== "input_required" || method !== "resources/read") {
        throw new Error(`Unsupported MCP result type for ${method}: ${String(result.resultType)}`);
      }
      if (result.inputRequests === undefined && result.requestState === undefined) {
        throw new Error(`MCP ${method} requested input without specifying it`);
      }
      attempt = { ...original };
      if (result.requestState !== undefined) attempt.requestState = result.requestState;
      if (result.inputRequests === undefined) continue;
      if (!isRecord(result.inputRequests)) throw new Error(`MCP ${method} returned malformed inputRequests`);
      const responses: Record<string, unknown> = Object.create(null);
      for (const [key, ask] of Object.entries(result.inputRequests)) {
        if (!isRecord(ask) || ask.method !== "roots/list" || !connection.roots) {
          throw new Error(`MCP ${method} requested input this binding cannot answer`);
        }
        responses[key] = { roots: connection.roots() };
      }
      attempt.inputResponses = responses;
    }
    throw new Error(`MCP ${method} still requested input after 8 round trips`);
  }

  return {
    sync(ctx) {
      const pending = tail.catch(() => {}).then(() => syncOnce(ctx));
      tail = pending;
      return pending;
    },
    notify,
    get gap() { return gap; },
    close() {
      if (closed) return;
      closed = true;
      controller.abort(new Error("MCP skills binding closed"));
      offNotifications?.();
      offNotifications = undefined;
      detachAll();
      releaseCapabilities?.();
      releaseCapabilities = undefined;
      manager = undefined;
    },
  };
}
