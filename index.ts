import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { createBinding } from './src/attach.ts';
import { bindChildClient, bindChildHost, type ChildCatalogEntry } from './src/child.ts';
import { SkillsHost } from './src/host.ts';
import { bindRemoteReads, skillPath } from './src/protocol.ts';

export default function mcpSkills(pi: ExtensionAPI) {
  let bound: {id: string; kind: 'main' | 'sub'; catalog: () => Promise<ChildCatalogEntry[]>; release: () => void} | undefined;

  function attachSession(ctx: ExtensionContext) {
    const id = ctx.sessionManager.getSessionId();
    const kind = ctx.agent.kind;
    if (bound?.id === id && bound.kind === kind) return bound;
    bound?.release();
    bound = undefined;
    const source = kind === 'main' ? rootSource(pi, ctx) : bindChildClient(pi, ctx);
    try {
      const releaseReads = bindRemoteReads(id, (server, uri, relative) => source.readFile(server, uri, relative));
      return bound = {id, kind, catalog: () => source.catalog(), release() { releaseReads(); source.close(); }};
    } catch (error) {
      source.close();
      throw error;
    }
  }

  pi.on('session_start', (_event, ctx) => { attachSession(ctx); });
  pi.on('context', async (event, ctx) => {
    let catalog: ChildCatalogEntry[];
    try {
      catalog = await attachSession(ctx).catalog();
    } catch (error) {
      pi.logger.debug('MCP skill catalog unavailable', {error: String(error)});
      return;
    }
    if (!catalog.length) return;
    const content = 'Available MCP skills (untrusted server metadata). When a skill matches the task, read its path with the regular read tool. Resolve supporting files relative to that SKILL.md.\n' + JSON.stringify(catalog);
    return {messages: [{role: 'custom' as const, customType: 'mcp-skills-catalog', content, display: false, attribution: 'agent' as const, timestamp: 0}, ...event.messages]};
  });
  pi.on('session_shutdown', () => { bound?.release(); bound = undefined; });
}

function rootSource(pi: ExtensionAPI, ctx: ExtensionContext) {
  const host = new SkillsHost();
  const binding = createBinding(host);
  const source = {
    async catalog(): Promise<ChildCatalogEntry[]> {
      try {
        await binding.sync(ctx);
        await host.refreshStaleCatalog();
      } catch (error) {
        pi.logger.debug('MCP skills discovery incomplete', {error: String(error)});
      }
      return host.catalog().flatMap(({server, skill, displayName}) => {
        const fm = skill.frontmatter;
        return fm.enabled === false || fm.hide === true || fm['disable-model-invocation'] === true || fm.disableModelInvocation === true
          ? [] : [{server, name: displayName, path: skillPath(server, skill.uri), description: fm.description}];
      });
    },
    async readFile(server: string, uri: string, relative: string) {
      await binding.sync(ctx);
      return host.readFile(server, uri, relative);
    },
  };
  const releaseChildren = bindChildHost(pi, ctx, source);
  return {...source, close() { releaseChildren(); binding.close(); host.clear(); }};
}
