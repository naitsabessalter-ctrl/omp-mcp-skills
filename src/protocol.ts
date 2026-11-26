import { InternalUrlRouter, type ProtocolHandler } from '@oh-my-pi/pi-coding-agent/internal-urls';

type Reader = (server: string, uri: string, relative: string) => Promise<{content: string | Buffer; contentType: string}>;
const scheme = 'mcp-skill';
// The router is process-wide; separate extension instances can serve distinct sessions.
const owners = Symbol.for('omp-mcp-skills.session-readers.v1');
type Handler = ProtocolHandler & {[owners]: Map<string, Reader>};

export function skillPath(server: string, uri: string): string {
  return `${scheme}://remote/${Buffer.from(server).toString('base64url')}/${Buffer.from(uri).toString('base64url')}/SKILL.md`;
}

function decodeIdentity(segment: string): string {
  const value = Buffer.from(segment, 'base64url').toString('utf8');
  if (!value || Buffer.from(value).toString('base64url') !== segment) throw new Error('Invalid remote skill identity');
  return value;
}

export function bindRemoteReads(id: string, read: Reader): () => void {
  if (!id) throw new Error('Cannot bind remote skills without a session id');
  const router = InternalUrlRouter.instance();
  let handler = router.getHandler(scheme) as Handler | undefined;
  if (handler && !handler[owners]) throw new Error(`The ${scheme} URI scheme already has another owner`);
  if (!handler) {
    const readers = new Map<string, Reader>();
    handler = {
      scheme, spec: {backing: 'remote', selectors: 'lines', immutable: true}, [owners]: readers,
      async resolve(url, ctx) {
        const owner = ctx?.sessionId ?? ctx?.session?.getSessionId?.();
        const reader = owner ? readers.get(owner) : undefined;
        if (!reader) throw new Error('No remote skill catalog for the calling session');
        const match = /^mcp-skill:\/\/remote\/([\w-]+)\/([\w-]+)\/([^?#]+)$/.exec(url.rawHref ?? url.href);
        if (!match) throw new Error('Invalid remote skill path; use the path from the skill catalog');
        const result = await reader(decodeIdentity(match[1]), decodeIdentity(match[2]), match[3]);
        if (readers.get(owner!) !== reader) throw new Error('Remote skill session changed during read');
        return {url: url.href, ...result};
      },
    };
    router.register(handler);
  }
  const readers = handler[owners];
  if (readers.has(id)) throw new Error(`Remote skill reader already bound for session ${id}`);
  readers.set(id, read);
  return () => {
    if (readers.get(id) !== read) return;
    readers.delete(id);
    if (!readers.size && router.getHandler(scheme) === handler) router.unregister(scheme);
  };
}
