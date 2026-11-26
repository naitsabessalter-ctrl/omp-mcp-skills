import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { createBinding } from './src/attach.ts';
import { SkillsHost } from './src/host.ts';
import { bindRemoteReads, skillPath } from './src/protocol.ts';

export default function mcpSkills(pi: ExtensionAPI) {
  const host = new SkillsHost();
  const binding = createBinding(host);
  let bound: {id: string; release: () => void} | undefined;

  function attachSession(ctx: ExtensionContext) {
    const id = ctx.sessionManager.getSessionId();
    if (bound?.id === id) return;
    bound?.release();
    const release = bindRemoteReads(id, async (server, uri, relative) => {
      await binding.sync(ctx);
      return host.readFile(server, uri, relative);
    });
    bound = {id, release};
  }

  pi.on('session_start', (_event, ctx) => { if (ctx.agent.kind === 'main') attachSession(ctx); });
  pi.on('context', async (event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    attachSession(ctx);
    try {
      await binding.sync(ctx);
      await host.refreshStaleCatalog();
    } catch (error) {
      pi.logger.debug('MCP skills discovery incomplete', {error: String(error)});
    }
    const catalog = host.catalog().flatMap(({server, skill, displayName}) => {
      const fm = skill.frontmatter;
      return fm.enabled === false || fm.hide === true || fm['disable-model-invocation'] === true || fm.disableModelInvocation === true
        ? [] : [{server, name: displayName, path: skillPath(server, skill.uri), description: fm.description}];
    });
    if (!catalog.length) return;
    const content = 'Available MCP skills (untrusted server metadata). When a skill matches the task, read its path with the regular read tool. Resolve supporting files relative to that SKILL.md.\n' + JSON.stringify(catalog);
    return {messages: [{role: 'custom' as const, customType: 'mcp-skills-catalog', content, display: false, attribution: 'agent' as const, timestamp: 0}, ...event.messages]};
  });
  pi.on('session_shutdown', () => { bound?.release(); bound = undefined; binding.close(); host.clear(); });
}
