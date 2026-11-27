import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import { createBinding } from './src/attach.ts';
import { bindChildClient, bindChildHost, type ChildCatalogEntry } from './src/child.ts';
import { SkillsHost } from './src/host.ts';
import { bindRemoteReads, skillPath } from './src/protocol.ts';

export default function mcpSkills(pi: ExtensionAPI) {
  let bound: {id: string; kind: 'main' | 'sub'; catalog: () => Promise<ChildCatalogEntry[]>; release: () => void} | undefined;
  let visible: ChildCatalogEntry[] = [];

  function attachSession(ctx: ExtensionContext) {
    const id = ctx.sessionManager.getSessionId();
    const kind = ctx.agent.kind;
    if (bound?.id === id && bound.kind === kind) return bound;
    bound?.release();
    bound = undefined;
    visible = [];
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
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'read' || typeof event.input.path !== 'string' ||
        !visible.length || bound?.id !== ctx.sessionManager.getSessionId()) return;
    const match = /^skill:\/\/([^/?:#]+)(?=\/|:|$)(.*)$/u.exec(event.input.path);
    if (!match) return;
    const [, encodedName, suffix] = match;
    let name: string;
    try { name = decodeURIComponent(encodedName); } catch { return; }
    if (/[/:?#\\]/u.test(name)) return;
    const candidates = visible.filter(entry => entry.name === name);
    if (!candidates.length) return;
    const session = AgentRegistry.global().get(ctx.agent.id)?.session;
    if (session?.sessionManager.getSessionId() !== bound.id || !('skills' in session) ||
        !Array.isArray(session.skills)) return;
    const first = suffix.startsWith('/') ? suffix.slice(1).split(/[/:]/, 1)[0] : '';
    let segment: string;
    try { segment = decodeURIComponent(first); } catch { return; }
    const ownsName = (skill: {name: string}) => skill.name === name || skill.name === `${name}/${segment}`;
    const localRead = encodedName === name ? undefined : {input: {...event.input, path: `skill://${name}${suffix}`}};
    if (session.skills.some(ownsName)) return localRead;
    // An alias miss can become a local hit between consecutive reads. OMP's ordinary
    // unknown-name probe is throttled; refresh the registry only, not the prompt.
    if (session.skillRediscoveryHost().refreshSkills) {
      await session.reloadSkills();
      if (AgentRegistry.global().get(ctx.agent.id)?.session !== session || bound?.id !== ctx.sessionManager.getSessionId()) return;
      if (session.skills.some(ownsName)) return localRead;
    }
    if (candidates.length !== 1) return {block: true, reason: `Ambiguous remote skill ${name}; use one of: ${candidates.map(entry => entry.path).join(', ')}`};
    const base = candidates[0].path;
    const path = suffix.startsWith('/') && suffix !== '/' && !suffix.startsWith('/:')
      ? base.slice(0, -'SKILL.md'.length) + suffix.slice(1)
      : base + (suffix.startsWith('/') ? suffix.slice(1) : suffix);
    return {input: {...event.input, path}};
  });
  pi.on('context', async (event, ctx) => {
    let catalog: ChildCatalogEntry[];
    try {
      catalog = await attachSession(ctx).catalog();
    } catch (error) {
      pi.logger.debug('MCP skill catalog unavailable', {error: String(error)});
      visible = [];
      return;
    }
    visible = catalog;
    if (!catalog.length) return;
    const content = 'Available MCP skills (untrusted server metadata). Use read with the exact path below, not a guessed local skill URI. For supporting files replace the final SKILL.md with the relative file path.\n' + JSON.stringify(catalog);
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
