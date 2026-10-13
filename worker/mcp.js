// MCP server (Streamable HTTP, stateless JSON responses) at /tack/api/mcp.
// Lets AI assistants read and edit the signed-in account's boards. Every edit goes through
// changeBoard(), which saves with a version check and retries, so app edits are never lost.
import { ID_RE, listBoards, getBoard, saveBoard, deleteBoard, changeBoard } from './boards.js';

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Tack is a sticky-note board for research and brainstorming (like Miro). Each board is a list of items.

Coordinates: x grows right, y grows down; x/y is an item's top-left corner. A default sticky note is 200×200; leave ~100 between notes (e.g. a grid with 300 spacing). The board is dark, so sticky notes should be light colors.

Item types:
- sticky: { type, x, y, w, h, text, color }. Text shrinks to fit. Colors: #fff59d yellow, #ffd59a orange, #ffb8cb pink, #dcc6f2 purple, #b8dcff blue, #c2ecc8 green, #e4e6ea gray, #ffffff white.
- text: { type, x, y, w, text, fontSize } — headings and labels (light text). fontSize 24 default, 40–56 for titles.
- shape: { type, x, y, w, h, shape, text, fill } — shape is rect | ellipse | diamond | triangle | hexagon | parallelogram | cylinder.
- connector: { type, from: { id, side }, to: { id, side }, endArrow, label } — a right-angle line between two items. side is left | right | top | bottom: the side of that item the line attaches to (e.g. a child below its parent: from bottom → to top). Lines route around other items automatically.
Text supports **bold** and URLs become clickable links.

Workflow: list_boards / get_board to look, then create_board or add_items / update_items / delete_items to change things. You can give new items your own ids (letters, digits, - or _) and reference them from connectors in the same add_items call. Don't rewrite whole boards when a few item changes will do.`;

const itemSchema = {
  type: 'object',
  description: 'A board item. See the server instructions for fields per type.',
  properties: {
    id: { type: 'string', description: 'Optional for new items; generated if missing.' },
    type: { type: 'string', enum: ['sticky', 'text', 'shape', 'connector'] },
    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
    text: { type: 'string' }, color: { type: 'string' }, fill: { type: 'string' },
    fontSize: { type: 'number' },
    shape: { type: 'string', enum: ['rect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'parallelogram', 'cylinder'] },
    from: { type: 'object', properties: { id: { type: 'string' }, side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } } },
    to: { type: 'object', properties: { id: { type: 'string' }, side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } } },
    endArrow: { type: 'boolean' }, startArrow: { type: 'boolean' }, label: { type: 'string' },
  },
  required: ['type'],
};

const boardIdProp = { board_id: { type: 'string', description: 'Board id from list_boards.' } };

const TOOLS = [
  { name: 'list_boards', description: 'List your boards (id, name, item count, last updated).', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_board', description: 'Get a board with all of its items.', inputSchema: { type: 'object', properties: boardIdProp, required: ['board_id'] } },
  { name: 'create_board', description: 'Create a new board, optionally with items. Returns its id.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, items: { type: 'array', items: itemSchema } }, required: ['name'] } },
  { name: 'rename_board', description: 'Rename a board.', inputSchema: { type: 'object', properties: { ...boardIdProp, name: { type: 'string' } }, required: ['board_id', 'name'] } },
  { name: 'delete_board', description: 'Delete a board. It disappears from every device.', inputSchema: { type: 'object', properties: boardIdProp, required: ['board_id'] } },
  { name: 'add_items', description: 'Add notes, text, shapes and lines to a board. Connectors can reference items added in the same call by id.', inputSchema: { type: 'object', properties: { ...boardIdProp, items: { type: 'array', items: itemSchema } }, required: ['board_id', 'items'] } },
  { name: 'update_items', description: 'Change existing items. Give each item\'s id and only the fields to change (e.g. text, color, x, y).', inputSchema: { type: 'object', properties: { ...boardIdProp, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }, required: ['board_id', 'items'] } },
  { name: 'delete_items', description: 'Remove items by id. Lines attached to removed items are removed too.', inputSchema: { type: 'object', properties: { ...boardIdProp, ids: { type: 'array', items: { type: 'string' } } }, required: ['board_id', 'ids'] } },
];

// ---------- item cleanup ----------
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 11);
const ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SIDES = ['left', 'right', 'top', 'bottom'];
const SHAPES = ['rect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'parallelogram', 'cylinder'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max = 5000) => (v == null ? '' : String(v).slice(0, max));

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Each item must be an object');
  const id = raw.id == null ? uid() : String(raw.id);
  if (!ITEM_ID.test(id)) throw new Error(`Bad item id "${id}" (use letters, digits, - or _)`);
  const box = (w, h) => ({ x: Math.round(num(raw.x, 0)), y: Math.round(num(raw.y, 0)), w: Math.max(20, Math.round(num(raw.w, w))), h: Math.max(20, Math.round(num(raw.h, h))) });
  switch (raw.type) {
    case 'sticky': {
      const size = num(raw.w ?? raw.h, 200);
      return { id, type: 'sticky', ...box(size, size), color: HEX.test(raw.color) ? raw.color : '#fff59d', text: str(raw.text) };
    }
    case 'text':
      return { id, type: 'text', ...box(320, 40), fontSize: Math.min(200, Math.max(6, num(raw.fontSize, 24))), text: str(raw.text), ...(HEX.test(raw.color) && { color: raw.color }) };
    case 'shape': {
      const shape = SHAPES.includes(raw.shape) ? raw.shape : 'rect';
      return { id, type: 'shape', shape, ...box(240, 140), text: str(raw.text), ...((HEX.test(raw.fill) || raw.fill === 'none') && { fill: raw.fill }) };
    }
    case 'connector': {
      const end = e => {
        if (e && e.id != null) return { id: String(e.id), ...(SIDES.includes(e.side) && { side: e.side }) };
        if (e && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y))) return { x: Number(e.x), y: Number(e.y) };
        throw new Error('Connector ends need { id, side } or { x, y }');
      };
      return {
        id, type: 'connector', from: end(raw.from), to: end(raw.to),
        endArrow: raw.endArrow !== false, ...(raw.startArrow && { startArrow: true }),
        ...(raw.label && { label: str(raw.label, 500) }), ...(HEX.test(raw.color) && { color: raw.color }),
      };
    }
    case 'image': // existing images can be moved and resized (upload new ones through the app or the REST API)
      if (!/^[a-z0-9]{1,40}$/.test(String(raw.img))) throw new Error('Image items need an uploaded image key in img');
      return { id, type: 'image', img: String(raw.img), ...box(320, 240) };
    case 'symbol':
      if (!Array.isArray(raw.nodes) || JSON.stringify(raw.nodes).length > 20000) throw new Error('Symbol items need Lucide icon nodes');
      return { id, type: 'symbol', icon: str(raw.icon, 80), nodes: raw.nodes, ...box(96, 96), ...(HEX.test(raw.color) && { color: raw.color }) };
    default:
      throw new Error(`Unsupported item type "${raw.type}" (use sticky, text, shape or connector)`);
  }
}

function checkConnectors(items) {
  const ids = new Set(items.filter(i => i.type !== 'connector').map(i => i.id));
  for (const c of items) {
    if (c.type !== 'connector') continue;
    for (const e of [c.from, c.to]) if (e.id && !ids.has(e.id)) throw new Error(`Connector ${c.id} points at missing item "${e.id}"`);
  }
}

const summary = b => ({ id: b.id, name: b.name, updatedAt: new Date(b.updatedAt).toISOString() });

// ---------- tools ----------
async function callTool(env, user, name, args = {}) {
  const needBoard = () => {
    const id = String(args.board_id || '');
    if (!ID_RE.test(id)) throw new Error('board_id must be a board id from list_boards');
    return id;
  };
  switch (name) {
    case 'list_boards': {
      const boards = (await listBoards(env, user)).filter(b => !b.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
      return { boards: boards.map(summary) };
    }
    case 'get_board': {
      const b = await getBoard(env, user, needBoard());
      if (!b) throw new Error('No board with that id');
      return { id: b.id, name: b.name, updatedAt: new Date(b.updatedAt).toISOString(), items: b.items };
    }
    case 'create_board': {
      const items = (args.items || []).map(cleanItem);
      checkConnectors(items);
      const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11) || 'b' + Date.now().toString(36);
      const saved = await saveBoard(env, user, id, { name: str(args.name, 200) || 'Untitled board', items, baseVersion: 0 });
      if (!saved.ok) throw new Error(saved.error);
      return { board_id: id, items: items.length };
    }
    case 'rename_board': {
      const r = await changeBoard(env, user, needBoard(), b => ({ ...b, name: str(args.name, 200) || b.name }));
      if (!r.ok) throw new Error(r.error);
      return { ok: true };
    }
    case 'delete_board': {
      await deleteBoard(env, user, needBoard());
      return { ok: true };
    }
    case 'add_items': {
      const r = await changeBoard(env, user, needBoard(), b => {
        const added = (args.items || []).map(cleanItem);
        const taken = new Set(b.items.map(i => i.id));
        for (const it of added) { if (taken.has(it.id)) throw new Error(`Item id "${it.id}" is already used on this board`); taken.add(it.id); }
        // lines first so they draw under the notes they connect
        const items = [...added.filter(i => i.type === 'connector'), ...b.items, ...added.filter(i => i.type !== 'connector')];
        checkConnectors(items);
        return { ...b, items, result: { added: added.map(i => i.id) } };
      });
      if (!r.ok) throw new Error(r.error);
      return r.result;
    }
    case 'update_items': {
      const r = await changeBoard(env, user, needBoard(), b => {
        const byId = new Map(b.items.map(i => [i.id, i]));
        const changed = [];
        for (const patch of args.items || []) {
          const cur = byId.get(String(patch?.id));
          if (!cur) throw new Error(`No item with id "${patch?.id}"`);
          const merged = cleanItem({ ...cur, ...patch, id: cur.id, type: cur.type });
          Object.keys(cur).forEach(k => delete cur[k]);
          Object.assign(cur, merged);
          changed.push(cur.id);
        }
        checkConnectors(b.items);
        return { ...b, result: { updated: changed } };
      });
      if (!r.ok) throw new Error(r.error);
      return r.result;
    }
    case 'delete_items': {
      const r = await changeBoard(env, user, needBoard(), b => {
        const kill = new Set((args.ids || []).map(String));
        for (const c of b.items) if (c.type === 'connector' && (kill.has(c.from?.id) || kill.has(c.to?.id))) kill.add(c.id);
        const items = b.items.filter(i => !kill.has(i.id));
        return { ...b, items, result: { removed: b.items.length - items.length } };
      });
      if (!r.ok) throw new Error(r.error);
      return r.result;
    }
    default:
      throw Object.assign(new Error(`Unknown tool "${name}"`), { rpc: -32602 });
  }
}

// ---------- JSON-RPC over HTTP ----------
export async function handleMcp(request, env, user) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  let msg;
  try { msg = await request.json(); } catch { return rpcError(null, -32700, 'Parse error'); }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(m => handleMessage(env, user, m)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handleMessage(env, user, msg);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}

async function handleMessage(env, user, msg) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // notification
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tack', title: 'Tack boards', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        const result = await callTool(env, user, params.name, params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (err) {
        if (err.rpc) return { jsonrpc: '2.0', id, error: { code: err.rpc, message: err.message } };
        return ok({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function rpcError(id, code, message) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 400 });
}
