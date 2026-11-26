import { test, expect } from 'bun:test';
import { SkillsHost } from './host.ts';
import { EXTENSION_ID, sha256, utf8, type McpPort } from './model.ts';

const uri = 'skill://example/SKILL.md';
const frontmatter = {name: 'example', description: 'A workflow'};
const text = '---\nname: example\ndescription: A workflow\n---\nContent.\n';
const entry = {uri, frontmatter, resources: [{uri, digest: sha256(utf8(text)), size: utf8(text).length}]};
const cache = {resultType: 'complete', ttlMs: 30000, cacheScope: 'private'};

async function session(request: McpPort['request']) {
  const host = new SkillsHost();
  await host.attach('origin', {request, capabilities: () => ({resources: {}, extensions: {[EXTENSION_ID]: {}}}),
    instructions: () => undefined, protocolVersion: () => '2026-07-28', onNotification: () => () => {}});
  return host;
}

test('denying a listed skill never fetches its bytes or activates it', async () => {
  const calls: string[] = [];
  const host = await session(async method => { calls.push(method); return {...cache, skills: [entry]}; });
  await expect(host.load('origin', 'example', () => false)).rejects.toThrow('not approved');
  expect(calls).toEqual(['skills/list']);
  expect(host.acting()).toEqual([]);
});

test('lookup by unlisted URI rejects substitution before approval', async () => {
  const calls: string[] = [];
  const host = await session(async method => { calls.push(method); return method === 'skills/list' ? {...cache, skills: []} : {...cache, skill: entry}; });
  await expect(host.load('origin', 'skill://other/SKILL.md', () => true)).rejects.toThrow('different URI');
  expect(calls).toEqual(['skills/list', 'skills/get']);
});

test('resource with matching bytes but another URI is not a successful read', async () => {
  const host = await session(async method => method === 'skills/list' ? {...cache, skills: [entry]} : {contents: [{uri: 'skill://other/SKILL.md', text}]});
  await expect(host.load('origin', uri, () => true)).rejects.toThrow('no contents');
  expect(host.acting()).toEqual([]);
});
