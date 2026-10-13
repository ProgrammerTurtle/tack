// Tack sync API, served at /tack/api/*. Everything else under /tack/ is the static app.
//
// Requests must come through Cloudflare Access, which signs in the user and adds a signed
// token (JWT). We verify that token ourselves rather than trusting any header blindly, and
// scope every read and write to the signed-in email address.
//
// Boards live in D1 (env.DB), images in KV (env.IMAGES).

const API = '/tack/api/';
const ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_BOARD_BYTES = 1_900_000; // D1 rows top out around 2 MB
const MAX_IMAGE_BYTES = 15_000_000;

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
  // Local development only (wrangler dev on localhost, DEV_USER set in .dev.vars): skip Access.
  const local = ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
  const devUser = local && env.DEV_USER ? String(env.DEV_USER).toLowerCase() : null;
  if (!devUser && (!env.TEAM_DOMAIN || !env.POLICY_AUD)) return json({ error: 'Sync is not configured yet' }, 503);
  const user = devUser || await verifyAccess(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const method = request.method;
  const parts = path.split('/').filter(Boolean);

  // Visiting /tack/api/login in the browser goes through the Access sign-in page, then lands here.
  // (Also send people who open the API's address directly back to the app.)
  if (parts[0] === 'login' || (!parts.length && method === 'GET')) return Response.redirect(new URL('/tack/', request.url).toString(), 302);
  if (parts[0] === 'me' && method === 'GET') return json({ email: user });

  if (parts[0] === 'boards') {
    const id = parts[1];
    if (!id) {
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const { results } = await env.DB.prepare(
        'SELECT id, name, version, updated_at AS updatedAt, deleted FROM boards WHERE user = ?'
      ).bind(user).all();
      return json({ boards: results.map(b => ({ ...b, deleted: !!b.deleted })) });
    }
    if (!ID_RE.test(id)) return json({ error: 'Bad board id' }, 400);
    const row = await env.DB.prepare('SELECT * FROM boards WHERE user = ? AND id = ?').bind(user, id).first();

    if (method === 'GET') {
      if (!row || row.deleted) return json({ error: 'Not found' }, 404);
      return json({ id, name: row.name, items: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at });
    }

    if (method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BOARD_BYTES) return json({ error: 'Board is too large to sync' }, 413);
      let board;
      try { board = JSON.parse(body); } catch { return json({ error: 'Bad JSON' }, 400); }
      if (!Array.isArray(board.items)) return json({ error: 'Missing items' }, 400);
      const base = Number(board.baseVersion) || 0;
      // Refuse to overwrite a newer copy saved from another device.
      if (row && !row.deleted && row.version !== base) {
        return json({ error: 'Conflict', version: row.version, updatedAt: row.updated_at }, 409);
      }
      const version = (row ? row.version : 0) + 1, now = Date.now();
      const name = String(board.name || 'Untitled board').slice(0, 200);
      await env.DB.prepare(
        `INSERT INTO boards (user, id, name, data, version, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (user, id) DO UPDATE SET name = excluded.name, data = excluded.data,
           version = excluded.version, updated_at = excluded.updated_at, deleted = 0`
      ).bind(user, id, name, JSON.stringify(board.items), version, now).run();
      return json({ version, updatedAt: now });
    }

    if (method === 'DELETE') {
      if (!row) return json({ ok: true });
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE boards SET deleted = 1, data = '[]', version = version + 1, updated_at = ? WHERE user = ? AND id = ?"
      ).bind(now, user, id).run();
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

// ---------- Cloudflare Access token verification ----------
let certCache = null; // { keys, at }

async function accessKeys(env) {
  if (certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Could not load Access certificates');
  const { keys } = await res.json();
  certCache = { keys, at: Date.now() };
  return keys;
}

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function verifyAccess(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || (cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/) || [])[1];
  if (!token) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  const jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.POLICY_AUD)) return null;
  if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return null;
  if (!payload.exp || payload.exp < now) return null;
  if (typeof payload.email !== 'string' || !payload.email) return null;
  return payload.email.toLowerCase();
}
