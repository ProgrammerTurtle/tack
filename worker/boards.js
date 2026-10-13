// Board storage in D1, shared by the REST API and the MCP server.
// Every save names the version it started from; a save based on an older version is refused,
// so nothing is silently overwritten. The check and the write happen in one statement.

export const ID_RE = /^[a-z0-9]{1,40}$/;
export const MAX_BOARD_BYTES = 1_900_000; // D1 rows top out around 2 MB

export async function listBoards(env, user) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, version, updated_at AS updatedAt, deleted FROM boards WHERE user = ?'
  ).bind(user).all();
  return results.map(b => ({ ...b, deleted: !!b.deleted }));
}

export async function getBoard(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM boards WHERE user = ? AND id = ?').bind(user, id).first();
  if (!row || row.deleted) return null;
  return { id, name: row.name, items: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at };
}

// Returns { ok: true, version, updatedAt } | { ok: false, status, error, version? }
export async function saveBoard(env, user, id, { name, items, baseVersion }) {
  if (!Array.isArray(items)) return { ok: false, status: 400, error: 'Missing items' };
  const data = JSON.stringify(items);
  if (data.length > MAX_BOARD_BYTES) return { ok: false, status: 413, error: 'Board is too large to sync' };
  const title = String(name || 'Untitled board').slice(0, 200);
  const base = Number(baseVersion) || 0, now = Date.now();

  // Either it's new (or was deleted), or it must still be at the version the caller started from.
  const res = await env.DB.prepare(
    `INSERT INTO boards (user, id, name, data, version, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, 1, ?5, 0)
     ON CONFLICT (user, id) DO UPDATE SET name = excluded.name, data = excluded.data,
       version = boards.version + 1, updated_at = excluded.updated_at, deleted = 0
     WHERE boards.deleted = 1 OR boards.version = ?6`
  ).bind(user, id, title, data, now, base).run();

  const row = await env.DB.prepare('SELECT version, updated_at FROM boards WHERE user = ? AND id = ?').bind(user, id).first();
  if (!res.meta.changes) return { ok: false, status: 409, error: 'Conflict', version: row?.version, updatedAt: row?.updated_at };
  return { ok: true, version: row.version, updatedAt: row.updated_at };
}

export async function deleteBoard(env, user, id) {
  await env.DB.prepare(
    "UPDATE boards SET deleted = 1, data = '[]', version = version + 1, updated_at = ? WHERE user = ? AND id = ? AND deleted = 0"
  ).bind(Date.now(), user, id).run();
}

// Read-modify-write with automatic retry if someone else saves in between.
export async function changeBoard(env, user, id, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const board = await getBoard(env, user, id);
    if (!board) return { ok: false, status: 404, error: `No board with id "${id}"` };
    const next = await change(structuredClone(board));
    if (next.error) return { ok: false, status: 400, error: next.error };
    const saved = await saveBoard(env, user, id, { name: next.name, items: next.items, baseVersion: board.version });
    if (saved.ok || saved.status !== 409) return { ...saved, result: next.result };
  }
  return { ok: false, status: 409, error: 'The board kept changing; try again.' };
}
