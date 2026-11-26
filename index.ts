import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { approvalMode } from './src/approval-mode.ts';
import { createBinding } from './src/attach.ts';
import { SkillsHost, type Approver } from './src/host.ts';
import { collisionLines, isCodeExecutionTool, SkillsFailure } from './src/model.ts';

function search(host: SkillsHost, query?: string, server?: string) {
  const entries = host.search(query, server);
  const lines = collisionLines(entries.map(e => ({server: e.server, name: e.skill.frontmatter.name, uri: e.skill.uri})));
  for (const e of entries) lines.push(`${e.server}\t${e.displayName}\t${e.skill.uri}\t${e.skill.frontmatter.description}`);
  if (!entries.length) lines.push('No skills matched.');
  for (const ref of host.references(server)) lines.push(`${ref.server}\t${ref.uri}\tUnconfirmed reference in server instructions`);
  for (const e of [...host.rejected(), ...host.errors()]) {
    if (!server || server === e.server) lines.push(`${e.server}: ${'reason' in e ? e.reason : e.message}`);
  }
  return lines.join('\n');
}

export default function mcpSkills(pi: ExtensionAPI) {
  const host = new SkillsHost();
  const binding = createBinding(host);
  const z = pi.zod;
  const server = z.string().describe('Configured MCP server name');
  const skill = z.string().describe('Skill name or full SKILL.md URI');
  const approve = z.boolean().optional().describe('Explicit grant in operator-enabled tool approval mode only');
  pi.registerFlag('mcp-skills-approvals', {type: 'string', default: 'ui', description: 'Approval mode: ui (default) or tool for trusted automation'});
  const mode = () => approvalMode(pi.getFlag('mcp-skills-approvals'));
  let execApproved = false;
  const approver = (ctx: ExtensionContext, grant?: boolean): Approver => async p =>
    mode() === 'tool' ? grant === true : ctx.hasUI && await ctx.ui.confirm(p.title, p.message);

  const run = async (ctx: ExtensionContext, action: () => Promise<string> | string) => {
    await binding.sync(ctx);
    return {content: [{type: 'text' as const, text: await action()}], details: {}};
  };
  pi.registerTool({name: 'mcp_skills_search', label: 'Search MCP skills', description: 'Search untrusted skill descriptions from connected MCP servers. Does not load skill files.',
    parameters: z.object({query: z.string().optional(), server: server.optional()}),
    execute: (_id, p, _signal, _update, ctx) => run(ctx, () => search(host, p.query, p.server))});
  pi.registerTool({name: 'mcp_skills_load', label: 'Load MCP skill', description: 'Verify and load a named MCP skill after approval. It grants no tools or permissions.',
    parameters: z.object({server, skill, approve}),
    execute: (_id, p, _signal, _update, ctx) => run(ctx, async () => (await host.load(p.server, p.skill, approver(ctx, p.approve))).text)});
  pi.registerTool({name: 'mcp_skills_read', label: 'Read MCP skill resource', description: 'Inspect a skill file without activating it; relative paths require a skill.',
    parameters: z.object({server, uri: z.string(), skill: skill.optional(), approve}),
    execute: (_id, p, _signal, _update, ctx) => run(ctx, async () => (await host.read(p.server, p.uri, p.skill, approver(ctx, p.approve))).text)});
  pi.registerTool({name: 'mcp_skills_directory', label: 'List MCP skill directory', description: 'List files in a skill directory using its manifest or server directory capability.',
    parameters: z.object({server, uri: z.string(), skill: skill.optional(), approve}),
    execute: (_id, p, _signal, _update, ctx) => run(ctx, async () => (await host.directory(p.server, p.uri, p.skill, approver(ctx, p.approve))).text)});
  pi.registerTool({name: 'mcp_skills_allow_exec', label: 'Allow execution with loaded skills', description: 'Grant code execution for this session in operator-enabled tool approval mode.',
    parameters: z.object({approve: z.boolean()}),
    async execute(_id, p) {
      if (mode() !== 'tool' || !p.approve) throw new SkillsFailure('Execution requires a user confirmation in UI mode or approve:true in tool mode.');
      execApproved = true;
      return {content: [{type: 'text' as const, text: 'Execution approved for this session.'}], details: {}};
    }});

  pi.registerCommand('mcp-skills', {description: 'search [text] | load <server> <skill name or URI>', async handler(args, ctx) {
    let text: string;
    try {
      await binding.sync(ctx);
      const input = args.trim();
      if (!input || /^search(?:\s|$)/.test(input)) text = search(host, input.slice(6).trim());
      else {
        // A skill name or URI has no spaces; configured server labels may have them.
        const match = /^load\s+(.+?)\s+(\S+)$/.exec(input);
        if (!match) throw new SkillsFailure('Usage: /mcp-skills search [text] | load <server> <skill name or URI>');
        const [, origin, ref] = match;
        text = (await host.load(origin, ref, p => p.kind === 'load' && p.server === origin || (ctx.hasUI && ctx.ui.confirm(p.title, p.message)))).text;
      }
    } catch (err) { text = `MCP Skills: ${err instanceof Error ? err.message : String(err)}`; }
    pi.sendMessage({customType: 'mcp-skills', content: text, display: true, attribution: 'agent'}, {triggerTurn: false});
  }});
  pi.on('tool_call', async (event, ctx) => {
    if (!isCodeExecutionTool(event.toolName) || !host.acting().length) return;
    const allowed = mode() === 'tool' ? execApproved : ctx.hasUI && await ctx.ui.confirm(`Run ${event.toolName}?`, `An untrusted MCP skill is loaded from ${host.acting().map(a => a.server).join(', ')}. It cannot grant code execution.`);
    if (!allowed) return {block: true, reason: 'Execution was not approved while an MCP skill is loaded.'};
  });
  pi.on('session_shutdown', () => { binding.close(); host.clear(); execApproved = false; });
}
