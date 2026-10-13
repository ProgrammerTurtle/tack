// OpenAPI description of Tack's API, served at /tack/api/openapi.json and rendered with Scalar at /tack/api/docs.

const SCALAR = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.2';

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema, description) => ({ required: true, ...(description && { description }), content: { 'application/json': { schema } } });
const jsonResponse = (description, schema) => ({ description, content: { 'application/json': { schema } } });
const errors = {
  401: { $ref: '#/components/responses/Unauthorized' },
};

const boardId = { name: 'id', in: 'path', required: true, description: 'Board id: 1–40 lowercase letters or digits.', schema: { type: 'string', pattern: '^[a-z0-9]{1,40}$' } };
const imageKey = { name: 'key', in: 'path', required: true, description: 'Image key (the `img` field of an image item).', schema: { type: 'string', pattern: '^[a-z0-9]{1,40}$' } };

export function openApiSpec(origin) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tack API',
      version: '1.0.0',
      description: [
        'Read and write your Tack boards. Every board belongs to one account, and you only ever see your own.',
        '',
        '**Signing in:** create an account or sign in with the `auth` endpoints. Browsers get a session cookie. Other clients can use the `token` from the sign-in response as `Authorization: Bearer <token>`.',
        '',
        '**Saving safely:** every board has a `version`. When you save, send the version you started from as `baseVersion`. If someone saved a newer version in the meantime, the save is refused with `409`, so nothing gets overwritten. Fetch the board again, reapply your change, and retry.',
        '',
        '**Coordinates:** x grows to the right and y grows downward. A default sticky note is 200×200.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://github.com/ProgrammerTurtle/tack/blob/main/LICENSE' },
    },
    servers: [{ url: `${origin}/tack/api` }],
    tags: [
      { name: 'Account', description: 'Create an account, sign in and out.' },
      { name: 'Boards', description: 'List, read, save and delete boards.' },
      { name: 'Images', description: 'Image files used by image items on boards.' },
      { name: 'AI tools', description: 'Connect AI assistants over MCP (Model Context Protocol). In the app: account menu → Connect an AI tool.' },
    ],
    security: [{ bearer: [] }, { session: [] }],
    paths: {
      '/auth/sign-up/email': {
        post: {
          tags: ['Account'], summary: 'Create an account', security: [],
          description: 'Creates an account and signs it in.',
          requestBody: jsonBody({ type: 'object', required: ['email', 'password', 'name'], properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            name: { type: 'string', description: 'Display name.' },
          } }),
          responses: {
            200: jsonResponse('Account created and signed in.', ref('AuthResult')),
            422: jsonResponse('An account with that email already exists, or the input is invalid.', ref('AuthError')),
          },
        },
      },
      '/auth/sign-in/email': {
        post: {
          tags: ['Account'], summary: 'Sign in', security: [],
          requestBody: jsonBody({ type: 'object', required: ['email', 'password'], properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          } }),
          responses: {
            200: jsonResponse('Signed in. Use `token` as a bearer token, or rely on the session cookie.', ref('AuthResult')),
            401: jsonResponse('Wrong email or password.', ref('AuthError')),
            429: { description: 'Too many attempts. Wait a minute.' },
          },
        },
      },
      '/auth/sign-out': {
        post: {
          tags: ['Account'], summary: 'Sign out',
          requestBody: jsonBody({ type: 'object' }),
          responses: { 200: jsonResponse('Signed out.', { type: 'object', properties: { success: { type: 'boolean' } } }) },
        },
      },
      '/me': {
        get: {
          tags: ['Account'], summary: 'Who am I',
          responses: { 200: jsonResponse('The signed-in account.', { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } }), ...errors },
        },
      },
      '/boards': {
        get: {
          tags: ['Boards'], summary: 'List boards',
          description: 'All of your boards, including deleted ones (`deleted: true`) so other devices can remove their copies.',
          responses: { 200: jsonResponse('Your boards.', { type: 'object', properties: { boards: { type: 'array', items: ref('BoardSummary') } } }), ...errors },
        },
      },
      '/boards/{id}': {
        parameters: [boardId],
        get: {
          tags: ['Boards'], summary: 'Get a board',
          responses: { 200: jsonResponse('The board and everything on it.', ref('Board')), 404: { description: 'No such board (or it was deleted).' }, ...errors },
        },
        put: {
          tags: ['Boards'], summary: 'Create or save a board',
          description: 'Saves the whole board. For a new board, use `baseVersion: 0` and pick a new id. Boards up to about 1.9 MB of JSON.',
          requestBody: jsonBody({ type: 'object', required: ['items'], properties: {
            name: { type: 'string', maxLength: 200 },
            items: { type: 'array', items: ref('Item') },
            baseVersion: { type: 'integer', description: 'The version you started from (0 for a new board).' },
          } }),
          responses: {
            200: jsonResponse('Saved.', { type: 'object', properties: { version: { type: 'integer' }, updatedAt: { type: 'integer', description: 'Unix time in ms.' } } }),
            409: jsonResponse('Someone saved a newer version first. Fetch the board and try again.', { type: 'object', properties: { error: { type: 'string' }, version: { type: 'integer' }, updatedAt: { type: 'integer' } } }),
            413: { description: 'Board too large.' },
            ...errors,
          },
        },
        delete: {
          tags: ['Boards'], summary: 'Delete a board',
          responses: { 200: jsonResponse('Deleted.', { type: 'object', properties: { ok: { type: 'boolean' } } }), ...errors },
        },
      },
      '/ai-keys': {
        post: {
          tags: ['AI tools'], summary: 'Create an AI key',
          description: 'Creates a long-lived key for an AI tool. Use it as `Authorization: Bearer <token>` with the MCP endpoint. Keys stay valid while in use (60 days after last use).',
          responses: { 200: jsonResponse('A new key.', { type: 'object', properties: { token: { type: 'string' } } }), ...errors },
        },
        delete: {
          tags: ['AI tools'], summary: 'Revoke all AI keys',
          responses: { 200: jsonResponse('How many keys were revoked.', { type: 'object', properties: { revoked: { type: 'integer' } } }), ...errors },
        },
      },
      '/mcp': {
        post: {
          tags: ['AI tools'], summary: 'MCP server',
          description: 'Model Context Protocol endpoint (Streamable HTTP, JSON responses). Tools: `list_boards`, `get_board`, `create_board`, `rename_board`, `delete_board`, `add_items`, `update_items`, `delete_items`.\n\nClaude Code: `claude mcp add --transport http tack <this URL> --header "Authorization: Bearer <AI key>"`',
          requestBody: jsonBody({ type: 'object', description: 'A JSON-RPC 2.0 message.', properties: { jsonrpc: { const: '2.0' }, id: {}, method: { type: 'string' }, params: { type: 'object' } } }),
          responses: { 200: jsonResponse('JSON-RPC response.', { type: 'object' }), 202: { description: 'Notification accepted.' }, ...errors },
        },
      },
      '/images/{key}': {
        parameters: [imageKey],
        get: {
          tags: ['Images'], summary: 'Download an image',
          responses: { 200: { description: 'The image file.', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } }, 404: { description: 'Not found.' }, ...errors },
        },
        put: {
          tags: ['Images'], summary: 'Upload an image',
          description: 'PNG, JPEG, GIF, WebP, AVIF, SVG or BMP, up to 15 MB. Then reference it from an image item with `img: <key>`.',
          requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 200: jsonResponse('Stored.', { type: 'object', properties: { ok: { type: 'boolean' } } }), 413: { description: 'Too large.' }, 415: { description: 'Not an image type.' }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'The `token` from sign-in.' },
        session: { type: 'apiKey', in: 'cookie', name: '__Secure-better-auth.session_token', description: 'Set automatically when you sign in from a browser.' },
      },
      responses: {
        Unauthorized: jsonResponse('Not signed in.', { type: 'object', properties: { error: { type: 'string' } } }),
      },
      schemas: {
        AuthResult: { type: 'object', properties: { token: { type: 'string', description: 'Session token; send as `Authorization: Bearer <token>`.' }, user: ref('User') } },
        AuthError: { type: 'object', properties: { message: { type: 'string' }, code: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } } },
        BoardSummary: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' }, version: { type: 'integer' },
          updatedAt: { type: 'integer', description: 'Unix time in ms.' }, deleted: { type: 'boolean' },
        } },
        Board: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' }, version: { type: 'integer' }, updatedAt: { type: 'integer' },
          items: { type: 'array', items: ref('Item') },
        } },
        Item: {
          description: 'Anything on a board. Items are drawn in array order (later on top); lines are always drawn under other items.',
          oneOf: [ref('Sticky'), ref('Text'), ref('Shape'), ref('Connector'), ref('Image'), ref('Symbol')],
          discriminator: { propertyName: 'type' },
        },
        Box: { type: 'object', required: ['id', 'x', 'y', 'w', 'h'], properties: {
          id: { type: 'string', description: 'Unique within the board.' },
          x: { type: 'number', description: 'Left edge.' }, y: { type: 'number', description: 'Top edge.' },
          w: { type: 'number' }, h: { type: 'number' },
        } },
        Sticky: { allOf: [ref('Box'), { type: 'object', required: ['type'], properties: {
          type: { const: 'sticky' },
          text: { type: 'string', description: 'Shrinks to fit the note. `**bold**` and URLs (shown as links) are supported.' },
          color: { type: 'string', description: 'Hex fill, e.g. `#fff59d` (yellow), `#ffd59a`, `#ffb8cb`, `#dcc6f2`, `#b8dcff`, `#c2ecc8`, `#e4e6ea`, `#ffffff`.' },
        } }] },
        Text: { allOf: [ref('Box'), { type: 'object', required: ['type'], properties: {
          type: { const: 'text' }, text: { type: 'string' },
          fontSize: { type: 'number', description: 'Default 24. Height follows the text.' },
          color: { type: 'string', description: 'Hex text color. Defaults to light text on the dark board.' },
        } }] },
        Shape: { allOf: [ref('Box'), { type: 'object', required: ['type', 'shape'], properties: {
          type: { const: 'shape' },
          shape: { enum: ['rect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'parallelogram', 'cylinder'] },
          text: { type: 'string' },
          fill: { type: 'string', description: 'Hex fill, or `none`.' },
        } }] },
        Symbol: { allOf: [ref('Box'), { type: 'object', required: ['type', 'nodes'], properties: {
          type: { const: 'symbol' }, icon: { type: 'string', description: 'Lucide icon name.' },
          nodes: { type: 'array', description: 'Lucide icon outline: `[tag, attributes]` pairs on a 24×24 grid.' },
          color: { type: 'string' },
        } }] },
        Image: { allOf: [ref('Box'), { type: 'object', required: ['type', 'img'], properties: {
          type: { const: 'image' }, img: { type: 'string', description: 'Key of an uploaded image (see Images).' },
        } }] },
        End: {
          description: 'One end of a line: attached to an item (`id`, and the `side` it leaves from), or a free point (`x`, `y`).',
          oneOf: [
            { type: 'object', required: ['id'], properties: { id: { type: 'string' }, side: { enum: ['left', 'right', 'top', 'bottom'] } } },
            { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          ],
        },
        Connector: { type: 'object', required: ['id', 'type', 'from', 'to'], properties: {
          id: { type: 'string' }, type: { const: 'connector' },
          from: ref('End'), to: ref('End'),
          endArrow: { type: 'boolean' }, startArrow: { type: 'boolean' },
          label: { type: 'string' }, color: { type: 'string' },
        }, description: 'A right-angle line between two items. Routes itself around other items.' },
      },
    },
  };
}

export function docsPage(origin) {
  const config = JSON.stringify({ theme: 'purple', darkMode: true, hideDownloadButton: false, metaData: { title: 'Tack API' } });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tack API</title>
</head>
<body>
  <script id="api-reference" data-url="${origin}/tack/api/openapi.json" data-configuration='${config}'></script>
  <script src="${SCALAR}"></script>
</body>
</html>`;
}
