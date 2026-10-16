/**
 * Acesso à interface de administração: login (sessão em cookie), usuários, perfis de
 * permissionamento e preferências do usuário.
 *
 * Os endpoints do MCP (/mcp/...) e o token OAuth (/oauth/token) não usam esta sessão:
 * eles têm a própria autenticação por conexão.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { onDbLoaded, store } from './store.js';
import type { Profile, User } from './types.js';

/* ----------------------------- permissões ----------------------------- */

export const PERMISSIONS = [
  { key: 'apps.view', label: 'Ver MCP Apps e tools', group: 'MCP Apps' },
  { key: 'apps.edit', label: 'Importar e editar MCP Apps, tools e laboratório (inclui IA)', group: 'MCP Apps' },
  { key: 'tools.approve', label: 'Aprovar, voltar para rascunho e desativar tools', group: 'MCP Apps' },
  { key: 'apps.test', label: 'Testar tools (playground e teste com IA)', group: 'MCP Apps' },
  { key: 'clients.view', label: 'Ver clientes e seus vínculos', group: 'Clientes' },
  { key: 'clients.edit', label: 'Cadastrar clientes e configurar vínculos (dados da API)', group: 'Clientes' },
  { key: 'credentials.manage', label: 'Ver e gerar client_id/secret e tokens das conexões', group: 'Conexões' },
  { key: 'logs.view', label: 'Ver Logs de Requisições', group: 'Operação' },
  { key: 'access.manage', label: 'Gerenciar usuários e perfis', group: 'Acesso' },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['key'];
const ALL = PERMISSIONS.map((p) => p.key) as string[];

const ADMIN_PROFILE_ID = 'admin';

/* ------------------------------- senhas -------------------------------- */

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('base64url');
  const h = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return `scrypt$16384$${salt}$${h}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, h] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const expected = Buffer.from(h, 'base64url');
  const got = scryptSync(pw, salt, expected.length, { N: Number(n), r: 8, p: 1 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/* ------------------------- seed (perfis + master) ------------------------ */

/**
 * Admin master. A senha inicial ("joel777") fica só como hash aqui; troque-a pela
 * tela (menu do usuário › Alterar senha).
 */
const MASTER_SEED = {
  username: 'joelson',
  name: 'Joelson',
  passwordHash: 'scrypt$16384$K5YEOi-tRCI_WWeq7O44zw$hfIMVxkucl1MSjJUNCqWt0SPdWEyqxzGsLuR0mGMpx-njRFTMUM2JyPNZs6XYREp44COmOJDdfxRjJbRI260-Q',
};

onDbLoaded(() => {
  let changed = false;
  const profiles = store.profiles();
  const admin = profiles.find((p) => p.id === ADMIN_PROFILE_ID);
  if (!admin) {
    const now = new Date().toISOString();
    profiles.push(
      { id: ADMIN_PROFILE_ID, name: 'Administrador', description: 'Acesso total', permissions: [...ALL], system: true, createdAt: now },
      {
        id: 'operador',
        name: 'Operador',
        description: 'Consulta e testa MCP Apps e clientes, sem alterar configuração',
        permissions: ['apps.view', 'apps.test', 'clients.view', 'logs.view'],
        createdAt: now,
      },
      { id: 'leitura', name: 'Somente leitura', description: 'Só visualização', permissions: ['apps.view', 'clients.view', 'logs.view'], createdAt: now },
    );
    changed = true;
  } else if (ALL.some((p) => !admin.permissions.includes(p))) {
    admin.permissions = [...ALL]; // novas permissões entram no Administrador
    changed = true;
  }
  if (!store.users().some((u) => u.master)) {
    const existing = store.users().find((u) => u.username === MASTER_SEED.username);
    if (existing) Object.assign(existing, { master: true, profileId: ADMIN_PROFILE_ID, active: true });
    else
      store.users().push({
        id: nanoid(12),
        ...MASTER_SEED,
        profileId: ADMIN_PROFILE_ID,
        active: true,
        master: true,
        createdAt: new Date().toISOString(),
      });
    changed = true;
  }
  return changed;
});

/* ------------------------------- sessões -------------------------------- */

const COOKIE = 'mcpf_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 12) * 3600_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readCookie(req: FastifyRequest, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function cookieHeader(value: string, maxAgeSec: number) {
  const secure = (process.env.PUBLIC_URL ?? '').startsWith('https://') ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  store.setSessions(store.sessions().filter((s) => Date.parse(s.expiresAt) > now));
  store.sessions().push({ hash: sha256(token), userId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString() });
  void store.save();
  return token;
}

function sessionUser(req: FastifyRequest): User | undefined {
  const token = readCookie(req, COOKIE);
  if (!token) return undefined;
  const h = sha256(token);
  const s = store.sessions().find((x) => x.hash === h);
  if (!s || Date.parse(s.expiresAt) <= Date.now()) return undefined;
  const u = store.users().find((x) => x.id === s.userId);
  return u?.active ? u : undefined;
}

export const permissionsOf = (u: User): string[] => store.profiles().find((p) => p.id === u.profileId)?.permissions ?? [];

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    perms?: Set<string>;
  }
}

const err = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** Exige a permissão (lança 403). */
export function requirePerm(req: FastifyRequest, ...perms: string[]) {
  if (!req.perms || !perms.some((p) => req.perms!.has(p)))
    throw err('Seu perfil não tem permissão para esta ação.', 403);
}
export const hasPerm = (req: FastifyRequest, p: string) => !!req.perms?.has(p);

/**
 * Regras de permissão por rota (a primeira que casar vale). Rotas de conexão são tratadas
 * à parte (dependem de a conexão ser de laboratório ou de cliente).
 */
const RULES: { method?: RegExp; url: RegExp; perm: string | string[] }[] = [
  { url: /^\/api\/(users|profiles|permissions)(\/|$|\?)/, perm: 'access.manage' },
  { url: /^\/api\/invocations/, perm: 'logs.view' },
  { url: /^\/api\/nexus\//, perm: ['clients.view', 'clients.edit'] },
  { method: /^GET$/, url: /^\/api\/clients/, perm: 'clients.view' },
  { url: /^\/api\/clients/, perm: 'clients.edit' },
  { method: /^POST$/, url: /^\/api\/apps\/[^/]+\/tools\/[^/]+\/(test|ai-test)$/, perm: 'apps.test' },
  { method: /^POST$/, url: /^\/api\/apps\/[^/]+\/tools\/bulk$/, perm: ['apps.edit', 'tools.approve'] },
  { method: /^PATCH$/, url: /^\/api\/apps\/[^/]+\/tools\/[^/]+$/, perm: ['apps.edit', 'tools.approve'] },
  { method: /^GET$/, url: /^\/api\/apps/, perm: 'apps.view' },
  { url: /^\/api\/apps/, perm: 'apps.edit' },
];

/** Rotas /api livres de login. */
const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/logout']);

export function registerAccess(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: 'Faça login para continuar.' });
    req.user = user;
    req.perms = new Set(permissionsOf(user));
    const rule = RULES.find((r) => (!r.method || r.method.test(req.method)) && r.url.test(path));
    if (rule) {
      const perms = Array.isArray(rule.perm) ? rule.perm : [rule.perm];
      if (!perms.some((p) => req.perms!.has(p))) return reply.code(403).send({ error: 'Seu perfil não tem permissão para esta ação.' });
    }
  });

  /* ------------------------------ login ------------------------------- */

  fastify.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string().trim().min(1), password: z.string().min(1) }).parse(req.body ?? {});
    const u = store.users().find((x) => x.username.toLowerCase() === b.username.toLowerCase());
    const ok = !!u && u.active && verifyPassword(b.password, u.passwordHash);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 400)); // freia tentativa e erro
      return reply.code(401).send({ error: u && !u.active ? 'Usuário desativado.' : 'Usuário ou senha inválidos.' });
    }
    u!.lastLoginAt = new Date().toISOString();
    const token = createSession(u!.id);
    reply.header('set-cookie', cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)));
    return meDto(u!);
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      const h = sha256(token);
      store.setSessions(store.sessions().filter((s) => s.hash !== h));
      void store.save();
    }
    reply.header('set-cookie', cookieHeader('', 0));
    return { ok: true };
  });

  fastify.get('/api/me', async (req) => meDto(req.user!));

  fastify.patch('/api/me/prefs', async (req) => {
    const Mode = z.enum(['cards', 'list']).optional();
    const b = z.object({ viewMode: z.object({ apps: Mode, clients: Mode }).optional() }).parse(req.body ?? {});
    const u = req.user!;
    const vm = Object.fromEntries(Object.entries(b.viewMode ?? {}).filter(([, v]) => v));
    u.prefs = { ...u.prefs, viewMode: { ...u.prefs?.viewMode, ...vm } };
    await store.save();
    return meDto(u);
  });

  fastify.post('/api/me/password', async (req) => {
    const b = z.object({ current: z.string().min(1), password: z.string().min(6, 'A nova senha precisa ter pelo menos 6 caracteres.') }).parse(req.body ?? {});
    const u = req.user!;
    if (!verifyPassword(b.current, u.passwordHash)) throw err('Senha atual incorreta.', 400);
    u.passwordHash = hashPassword(b.password);
    await store.save();
    return { ok: true };
  });

  /* ---------------------------- permissões ---------------------------- */

  fastify.get('/api/permissions', async () => PERMISSIONS);

  /* ------------------------------ perfis ------------------------------ */

  const getProfile = (id: string) => {
    const p = store.profiles().find((x) => x.id === id);
    if (!p) throw err('Perfil não encontrado', 404);
    return p;
  };
  const profileDto = (p: Profile) => ({ ...p, userCount: store.users().filter((u) => u.profileId === p.id).length });
  const PermList = z.array(z.enum(ALL as [string, ...string[]]));

  fastify.get('/api/profiles', async () => store.profiles().map(profileDto));

  fastify.post('/api/profiles', async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(200).optional(), permissions: PermList }).parse(req.body);
    if (store.profiles().some((p) => p.name.toLowerCase() === b.name.toLowerCase())) throw err('Já existe perfil com esse nome.', 409);
    const p: Profile = { id: nanoid(10), name: b.name, description: b.description, permissions: [...new Set(b.permissions)], createdAt: new Date().toISOString() };
    store.profiles().push(p);
    await store.save();
    reply.code(201);
    return profileDto(p);
  });

  fastify.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    const p = getProfile(req.params.id);
    const b = z
      .object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(200).optional(), permissions: PermList.optional() })
      .parse(req.body);
    if (b.name && store.profiles().some((x) => x.id !== p.id && x.name.toLowerCase() === b.name!.toLowerCase())) throw err('Já existe perfil com esse nome.', 409);
    if (p.system && b.permissions) throw err('O perfil Administrador sempre tem todas as permissões.', 400);
    if (b.name) p.name = b.name;
    if (b.description !== undefined) p.description = b.description || undefined;
    if (b.permissions) p.permissions = [...new Set(b.permissions)];
    await store.save();
    return profileDto(p);
  });

  fastify.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const p = getProfile(req.params.id);
    if (p.system) throw err('O perfil Administrador não pode ser excluído.', 400);
    const n = store.users().filter((u) => u.profileId === p.id).length;
    if (n) throw err(`Perfil em uso por ${n} usuário(s). Troque o perfil deles antes de excluir.`, 409);
    store.setProfiles(store.profiles().filter((x) => x.id !== p.id));
    await store.save();
    reply.code(204);
  });

  /* ----------------------------- usuários ----------------------------- */

  const getUser = (id: string) => {
    const u = store.users().find((x) => x.id === id);
    if (!u) throw err('Usuário não encontrado', 404);
    return u;
  };
  const Username = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,40}$/, 'Usuário: 3 a 40 caracteres (letras, números, ponto, hífen ou _).');

  fastify.get('/api/users', async () => store.users().map(userDto));

  fastify.post('/api/users', async (req, reply) => {
    const b = z
      .object({
        username: Username,
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().optional().or(z.literal('')),
        profileId: z.string(),
        password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres.'),
      })
      .parse(req.body);
    getProfile(b.profileId);
    if (store.users().some((u) => u.username === b.username)) throw err('Já existe usuário com esse login.', 409);
    const u: User = {
      id: nanoid(12),
      username: b.username,
      name: b.name,
      email: b.email || undefined,
      passwordHash: hashPassword(b.password),
      profileId: b.profileId,
      active: true,
      createdAt: new Date().toISOString(),
    };
    store.users().push(u);
    await store.save();
    reply.code(201);
    return userDto(u);
  });

  fastify.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const u = getUser(req.params.id);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        email: z.string().trim().email().optional().or(z.literal('')),
        profileId: z.string().optional(),
        active: z.boolean().optional(),
        password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres.').optional(),
      })
      .parse(req.body);
    if (u.master && ((b.profileId && b.profileId !== u.profileId) || b.active === false))
      throw err('O admin master não pode mudar de perfil nem ser desativado.', 400);
    if (u.id === req.user!.id && b.active === false) throw err('Você não pode desativar o próprio usuário.', 400);
    if (b.profileId) getProfile(b.profileId);
    if (b.name) u.name = b.name;
    if (b.email !== undefined) u.email = b.email || undefined;
    if (b.profileId) u.profileId = b.profileId;
    if (b.active !== undefined) u.active = b.active;
    if (b.password) u.passwordHash = hashPassword(b.password);
    // desativado ou senha redefinida: encerra as sessões abertas dele
    if (b.active === false || b.password) store.setSessions(store.sessions().filter((s) => s.userId !== u.id || u.id === req.user!.id));
    await store.save();
    return userDto(u);
  });

  fastify.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const u = getUser(req.params.id);
    if (u.master) throw err('O admin master não pode ser excluído.', 400);
    if (u.id === req.user!.id) throw err('Você não pode excluir o próprio usuário.', 400);
    store.setUsers(store.users().filter((x) => x.id !== u.id));
    store.setSessions(store.sessions().filter((s) => s.userId !== u.id));
    await store.save();
    reply.code(204);
  });
}

function userDto(u: User) {
  const p = store.profiles().find((x) => x.id === u.profileId);
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    profileId: u.profileId,
    profileName: p?.name ?? '—',
    active: u.active,
    master: !!u.master,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

function meDto(u: User) {
  return { ...userDto(u), permissions: permissionsOf(u), prefs: { viewMode: { apps: 'cards', clients: 'cards', ...u.prefs?.viewMode } } };
}
