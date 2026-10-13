// Tack sync API, served at /tack/api/*. Everything else under /tack/ is the static app.
//
// Accounts are email/password via Better Auth (/tack/api/auth/*). Every other API call needs a
// valid session, and all reads and writes are scoped to that account's user id.
//
// Boards live in D1 (env.DB), images in KV (env.IMAGES).
import { createAuth, AUTH_BASE } from './auth.js';
import { openApiSpec, docsPage } from './openapi.js';
import { ID_RE, MAX_BOARD_BYTES, listBoards, getBoard, saveBoard, deleteBoard } from './boards.js';
import { handleMcp } from './mcp.js';

const API = '/tack/api/';
const MAX_IMAGE_BYTES = 15_000_000;
const AI_KEY_LABEL = 'Tack AI key';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API)) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url.pathname.slice(API.length));
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  },
};

async function handleApi(request, env, path) {
  // Public API reference
  const origin = new URL(request.url).origin;
  if (path === 'openapi.json' && request.method === 'GET') return json(openApiSpec(origin));
  if (path === 'docs' && request.method === 'GET') {
    return new Response(docsPage(origin), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }
  if (!env.BETTER_AUTH_SECRET) return json({ error: 'Sync is not configured yet' }, 503);
  const auth = createAuth(env, request);
  if (new URL(request.url).pathname.startsWith(AUTH_BASE + '/')) return auth.handler(request);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const res = json({ error: 'Not signed in' }, 401);
    if (path === 'mcp') res.headers.set('WWW-Authenticate', 'Bearer realm="tack"');
    return res;
  }
  const user = session.user.id;
  const method = request.method;
  const parts = path.split('/').filter(Boolean);

  // People who open the API's address directly get sent back to the app.
  if (!parts.length && method === 'GET') return Response.redirect(new URL('/tack/', request.url).toString(), 302);
  if (parts[0] === 'me' && method === 'GET') return json({ email: session.user.email, id: user });

  // MCP server for AI tools (authenticated with an AI key as a bearer token)
  if (path === 'mcp') return handleMcp(request, env, user);

  // AI keys: separate long-lived sessions an AI tool uses as its bearer token.
  if (parts[0] === 'ai-keys') {
    if (method === 'POST') {
      const ctx = await auth.$context;
      const s = await ctx.internalAdapter.createSession(user, false, { userAgent: AI_KEY_LABEL });
      return json({ token: s.token });
    }
    if (method === 'DELETE') {
      const res = await env.DB.prepare('DELETE FROM "session" WHERE "userId" = ? AND "userAgent" = ?').bind(user, AI_KEY_LABEL).run();
      return json({ revoked: res.meta.changes });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (parts[0] === 'boards') {
    const id = parts[1];
    if (!id) {
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json({ boards: await listBoards(env, user) });
    }
    if (!ID_RE.test(id)) return json({ error: 'Bad board id' }, 400);
    if (method === 'GET') {
      const board = await getBoard(env, user, id);
      return board ? json(board) : json({ error: 'Not found' }, 404);
    }
    if (method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BOARD_BYTES) return json({ error: 'Board is too large to sync' }, 413);
      let board;
      try { board = JSON.parse(body); } catch { return json({ error: 'Bad JSON' }, 400); }
      const saved = await saveBoard(env, user, id, board);
      if (!saved.ok) return json({ error: saved.error, version: saved.version, updatedAt: saved.updatedAt }, saved.status);
      return json({ version: saved.version, updatedAt: saved.updatedAt });
    }
    if (method === 'DELETE') {
      await deleteBoard(env, user, id);
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (parts[0] === 'images' && parts[1]) {
    const key = parts[1];
    if (!ID_RE.test(key)) return json({ error: 'Bad image id' }, 400);
    const kvKey = `${user}:${key}`;
    if (method === 'GET') {
      const { value, metadata } = await env.IMAGES.getWithMetadata(kvKey, { type: 'arrayBuffer' });
      if (!value) return json({ error: 'Not found' }, 404);
      return new Response(value, {
        headers: {
          'Content-Type': metadata?.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }
    if (method === 'PUT') {
      const type = request.headers.get('Content-Type') || '';
      if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp)$/.test(type)) return json({ error: 'Not an image' }, 415);
      const data = await request.arrayBuffer();
      if (data.byteLength > MAX_IMAGE_BYTES) return json({ error: 'Image is too large to sync' }, 413);
      await env.IMAGES.put(kvKey, data, { metadata: { type } });
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  return json({ error: 'Not found' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
