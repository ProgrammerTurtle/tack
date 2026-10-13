// Email/password accounts with Better Auth, stored in the same D1 database as the boards.
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';

export const AUTH_BASE = '/tack/api/auth';

// Passwords are hashed with PBKDF2-SHA256 from the Workers runtime's built-in Web Crypto,
// which is fast enough for Workers' CPU limits (Better Auth's default scrypt is not).
// Stored as "pbkdf2$<iterations>$<salt>$<hash>" so the iteration count can be raised later.
const ITERATIONS = 100_000;
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

async function verifyPassword({ hash, password }) {
  const [kind, iter, salt, expected] = String(hash).split('$');
  if (kind !== 'pbkdf2' || !salt || !expected) return false;
  const got = new Uint8Array(await derive(password, unb64(salt), Number(iter)));
  const want = unb64(expected);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // constant-time compare
  return diff === 0;
}

export function createAuth(env, request) {
  const origin = new URL(request.url).origin;
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: AUTH_BASE,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 60, // stay signed in for 60 days
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    // Non-browser clients (scripts, the API docs' "try it", MCP) send the session token as a bearer token.
    plugins: [bearer()],
    telemetry: { enabled: false },
  });
}
