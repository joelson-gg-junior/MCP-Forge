import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { LAB_CLIENT, RESERVED_CLIENT_SLUGS, TOKEN_TTL_SECONDS, loadDb, newOAuthClient, store } from './store.js';
import { fetchSpecText, importSpec, lintTool, parseSpecText, toolName } from './importer.js';
import { registerMcpRoutes, visibleSchema } from './mcp.js';
import { callUpstream, targetFor } from './upstream.js';
import { listOrganizations, nexusConfigured, nexusSessionInfo } from './nexus.js';
import { aiConfigured, aiModel, generateToolDocs, testToolWithMessage } from './ai.js';
import { hasPerm, registerAccess, requirePerm } from './access.js';
import type { App, Client, Connection, Tool, UpstreamAuth } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const MASK = '••••••';

loadDb();
const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 20 * 1024 * 1024 });
await fastify.register(cors, { origin: true });
// /oauth/token aceita application/x-www-form-urlencoded (padrão OAuth 2.0)
// login, usuários, perfis e permissões da interface (antes das demais rotas)
registerAccess(fastify);
fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
  done(null, Object.fromEntries(new URLSearchParams(body as string))),
);

/* ------------------------------ helpers ------------------------------ */

function slugify(s: string, taken: (slug: string) => unknown = (x) => store.app(x) || x === 'lab', fallback = 'app') {
  const base =
    toolName(s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
      .replace(/_/g, '-')
      .slice(0, 40)
      .replace(/-+$/, '') || fallback;
  let slug = base;
  let i = 2;
  while (taken(slug)) slug = `${base}-${i++}`;
  return slug;
}

function maskAuth(a: UpstreamAuth): UpstreamAuth {
  switch (a.type) {
    case 'bearer':
      return { ...a, token: a.token ? MASK : '' };
    case 'basic':
      return { ...a, password: a.password ? MASK : '' };
    case 'apiKey':
      return { ...a, value: a.value ? MASK : '' };
    default:
      return a;
  }
}

/** Nome exibido do cliente: nome fantasia, se houver. */
const clientLabel = (c: Client) => c.tradeName || c.name;

const mcpUrlFor = (client: Client, app: App) => `${PUBLIC_URL}/mcp/${client.slug}/${app.slug}`;
const TOKEN_URL = `${PUBLIC_URL}/oauth/token`;

/** Cliente dono da conexão (o laboratório é um cliente virtual). */
const clientOf = (c: Connection) => (c.lab ? LAB_CLIENT : store.client(c.clientId));

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** curl pronto para gerar o Bearer token da conexão (OAuth 2.0 client_credentials). */
const authCurl = (c: Connection) =>
  [
    `curl -X POST ${shq(TOKEN_URL)}`,
    `-H 'Content-Type: application/x-www-form-urlencoded'`,
    `--data-urlencode 'grant_type=client_credentials'`,
    `--data-urlencode ${shq(`client_id=${c.oauth.clientId}`)}`,
    `--data-urlencode ${shq(`client_secret=${c.oauth.clientSecret}`)}`,
  ].join(' \\\n  ');

function toDto(app: App, full = true) {
  const counts = { total: app.tools.length, approved: 0, draft: 0, disabled: 0 };
  for (const t of app.tools) counts[t.status]++;
  const conns = store.connections({ appId: app.id });
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    baseUrl: app.baseUrl,
    source: app.source,
    createdAt: app.createdAt,
    counts,
    clientCount: conns.length,
    labConnectionId: store.labConnection(app.id)?.id,
    ...(full
      ? {
          tools: app.tools.map((t) => ({ ...t, lint: lintTool(t) })),
          connections: conns.map((c) => connSummary(c)).filter(Boolean),
        }
      : {}),
  };
}

function connSummary(c: Connection) {
  const app = store.app(c.appId);
  const client = clientOf(c);
  if (!app || !client) return null;
  return {
    id: c.id,
    enabled: c.enabled,
    app: { id: app.id, slug: app.slug, name: app.name },
    client: { id: client.id, slug: client.slug, name: clientLabel(client) },
    baseUrl: c.baseUrl || app.baseUrl,
    authType: c.auth.type,
    approvedTools: app.tools.filter((t) => t.status === 'approved').length,
    mcpUrl: mcpUrlFor(client, app),
  };
}

function connDto(c: Connection, showSecrets = true) {
  const app = getApp(c.appId);
  const client = c.lab ? LAB_CLIENT : getClient(c.clientId);
  return {
    id: c.id,
    lab: !!c.lab,
    enabled: c.enabled,
    app: { id: app.id, slug: app.slug, name: app.name, baseUrl: app.baseUrl, approvedTools: app.tools.filter((t) => t.status === 'approved').length },
    client: { id: client.id, slug: client.slug, name: clientLabel(client) },
    baseUrl: c.baseUrl,
    effectiveBaseUrl: c.baseUrl || app.baseUrl,
    auth: maskAuth(c.auth),
    extraHeaders: c.extraHeaders,
    requireAccessKey: c.requireAccessKey,
    mcpUrl: mcpUrlFor(client, app),
    oauth: {
      clientId: c.oauth.clientId,
      clientSecret: showSecrets ? c.oauth.clientSecret : '',
      createdAt: c.oauth.createdAt,
      canManage: showSecrets,
      tokenUrl: TOKEN_URL,
      tokenTtlSeconds: TOKEN_TTL_SECONDS,
      activeTokens: store.activeTokens(c.id).length,
      curl: showSecrets ? authCurl(c) : authCurl({ ...c, oauth: { ...c.oauth, clientSecret: '<client_secret>' } }),
    },
    legacyUrl: c.legacyAppSlug ? `${PUBLIC_URL}/mcp/${c.legacyAppSlug}` : undefined,
    createdAt: c.createdAt,
  };
}

function clientDto(c: Client) {
  return {
    ...c,
    connections: store
      .connections({ clientId: c.id })
      .map((x) => connSummary(x))
      .filter(Boolean),
  };
}

function getApp(id: string) {
  const app = store.app(id);
  if (!app) throw Object.assign(new Error('App não encontrado'), { statusCode: 404 });
  return app;
}

function getClient(id: string) {
  const c = store.client(id);
  if (!c) throw Object.assign(new Error('Cliente não encontrado'), { statusCode: 404 });
  return c;
}

function getConnection(id: string) {
  const c = store.connection(id);
  if (!c) throw Object.assign(new Error('Vínculo não encontrado'), { statusCode: 404 });
  return c;
}

/** Conexão com checagem de permissão: laboratório segue as permissões de MCP Apps, cliente as de Clientes. */
function connFor(req: any, id: string, mode: 'view' | 'edit' | 'credentials') {
  const c = getConnection(id);
  if (mode === 'credentials') requirePerm(req, 'credentials.manage');
  else if (c.lab) requirePerm(req, ...(mode === 'view' ? ['apps.view', 'apps.edit'] : ['apps.edit']));
  else requirePerm(req, ...(mode === 'view' ? ['clients.view', 'clients.edit'] : ['clients.edit']));
  return c;
}
const dto = (req: any, c: Connection) => connDto(c, hasPerm(req, 'credentials.manage'));

function getTool(app: App, toolId: string) {
  const t = app.tools.find((x) => x.id === toolId);
  if (!t) throw Object.assign(new Error('Tool não encontrada'), { statusCode: 404 });
  return t;
}

fastify.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Dados inválidos', details: err.issues });
  reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Erro interno' });
});

/* -------------------------------- apps -------------------------------- */

fastify.get('/api/health', async () => ({ ok: true }));

fastify.get('/api/apps', async () => store.apps().map((a) => toDto(a, false)));

fastify.get<{ Params: { id: string } }>('/api/apps/:id', async (req) => toDto(getApp(req.params.id)));

const ImportBody = z
  .object({
    name: z.string().trim().max(80).optional(),
    url: z.string().url().optional(),
    content: z.string().optional(),
    baseUrl: z.string().url().optional().or(z.literal('')),
  })
  .refine((b) => b.url || b.content, { message: 'Informe a URL da documentação ou cole o conteúdo.' });

fastify.post('/api/apps/import', async (req, reply) => {
  const body = ImportBody.parse(req.body);
  let result;
  try {
    const text = body.content?.trim() ? body.content : await fetchSpecText(body.url!);
    result = importSpec(parseSpecText(text), body.url);
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? String(e)), { statusCode: 400 });
  }
  const name = body.name || result.title || 'Nova API';
  const app: App = {
    id: nanoid(12),
    slug: slugify(name),
    name,
    baseUrl: (body.baseUrl || result.baseUrl || '').replace(/\/+$/, ''),
    source: { kind: result.kind, url: body.url, title: result.title, version: result.version },
    createdAt: new Date().toISOString(),
    tools: result.tools,
  };
  await store.addApp(app);
  reply.code(201);
  return { app: toDto(app), warnings: result.warnings };
});

/** Reimporta a documentação: atualiza tools existentes (por método+path) preservando edições aprovadas. */
fastify.post<{ Params: { id: string } }>('/api/apps/:id/reimport', async (req) => {
  const app = getApp(req.params.id);
  const b = z.object({ url: z.string().url().optional(), content: z.string().optional() }).parse(req.body ?? {});
  const url = b.url ?? app.source.url;
  if (!b.content && !url) throw Object.assign(new Error('Sem URL de origem; cole o conteúdo.'), { statusCode: 400 });
  const result = importSpec(parseSpecText(b.content ?? (await fetchSpecText(url!))), url);
  const key = (t: Tool) => `${t.method} ${t.path}`;
  const old = new Map(app.tools.map((t) => [key(t), t]));
  const added: string[] = [];
  const changed: string[] = [];
  const next = result.tools.map((nt) => {
    const ot = old.get(key(nt));
    if (!ot) {
      added.push(nt.name);
      return nt;
    }
    old.delete(key(nt));
    const schemaChanged = JSON.stringify(ot.params) !== JSON.stringify(nt.params);
    if (schemaChanged) {
      changed.push(ot.name);
      // contrato mudou: volta para draft para revisão humana
      return { ...ot, inputSchema: nt.inputSchema, params: nt.params, status: 'draft' as const, updatedAt: nt.updatedAt };
    }
    return ot;
  });
  const removed = [...old.values()].map((t) => t.name);
  app.tools = next;
  app.source = { ...app.source, url, version: result.version, title: result.title };
  await store.save();
  return { app: toDto(app), added, changed, removed, warnings: result.warnings };
});

const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('apiKey'), headerName: z.string().min(1), value: z.string(), in: z.enum(['header', 'query']).optional() }),
]);

fastify.patch<{ Params: { id: string } }>('/api/apps/:id', async (req) => {
  const app = getApp(req.params.id);
  const b = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      baseUrl: z.string().url().or(z.literal('')).optional(),
    })
    .parse(req.body);
  if (b.name) app.name = b.name;
  if (b.baseUrl !== undefined) app.baseUrl = b.baseUrl.replace(/\/+$/, '');
  await store.save();
  return toDto(app);
});

/** Aplica um PATCH de auth; segredo mascarado = manter o valor salvo. */
function mergeAuth(prev: UpstreamAuth, incoming: UpstreamAuth): UpstreamAuth {
  const next = { ...incoming } as any;
  for (const f of ['token', 'password', 'value']) if (next[f] === MASK && prev.type === next.type) next[f] = (prev as any)[f];
  return next;
}

fastify.delete<{ Params: { id: string } }>('/api/apps/:id', async (req, reply) => {
  getApp(req.params.id);
  await store.removeApp(req.params.id);
  reply.code(204);
});

/* -------------------------------- tools ------------------------------- */

fastify.patch<{ Params: { id: string; toolId: string } }>('/api/apps/:id/tools/:toolId', async (req) => {
  const app = getApp(req.params.id);
  const t = getTool(app, req.params.toolId);
  const b = z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Use a-z, 0-9, _ e - (até 64)').optional(),
      description: z.string().min(1).max(4000).optional(),
      status: z.enum(['draft', 'approved', 'disabled']).optional(),
      paramDescriptions: z.record(z.string(), z.string()).optional(),
    })
    .parse(req.body);
  if (b.status) requirePerm(req, 'tools.approve');
  if (b.name || b.description || b.paramDescriptions) requirePerm(req, 'apps.edit');
  if (b.name && b.name !== t.name) {
    if (app.tools.some((x) => x.name === b.name)) throw Object.assign(new Error('Já existe tool com esse nome'), { statusCode: 409 });
    t.name = b.name;
  }
  if (b.description) t.description = b.description;
  if (b.paramDescriptions) {
    const props = (t.inputSchema as any).properties ?? {};
    for (const [k, d] of Object.entries(b.paramDescriptions)) if (props[k]) props[k].description = d;
  }
  // editar conteúdo de uma tool aprovada exige nova aprovação (a menos que o status venha junto)
  const contentChanged = !!(b.name || b.description || b.paramDescriptions);
  if (b.status) t.status = b.status;
  else if (contentChanged && t.status === 'approved') t.status = 'draft';
  t.updatedAt = new Date().toISOString();
  await store.save();
  return { ...t, lint: lintTool(t) };
});

fastify.post<{ Params: { id: string } }>('/api/apps/:id/tools/bulk', async (req) => {
  const app = getApp(req.params.id);
  requirePerm(req, 'tools.approve');
  const b = z.object({ ids: z.array(z.string()).min(1), status: z.enum(['draft', 'approved', 'disabled']) }).parse(req.body);
  const set = new Set(b.ids);
  let n = 0;
  for (const t of app.tools)
    if (set.has(t.id)) {
      t.status = b.status;
      t.updatedAt = new Date().toISOString();
      n++;
    }
  await store.save();
  return { updated: n };
});

/* --------------------------- IA (descrições) --------------------------- */

fastify.get('/api/ai/status', async () => ({ configured: aiConfigured(), model: aiModel() }));

/**
 * Gera com IA a descrição da tool e dos parâmetros. Devolve a sugestão sem salvar:
 * a tela mostra para revisão e salva pelo PATCH normal (tool aprovada volta para rascunho).
 * Usa como contexto, quando houver, a última resposta de sucesso da API registrada nos logs.
 */
fastify.post<{ Params: { id: string; toolId: string } }>('/api/apps/:id/tools/:toolId/ai-describe', async (req) => {
  const app = getApp(req.params.id);
  const t = getTool(app, req.params.toolId);
  const last = store.invocations({ app: app.slug, status: '2xx', limit: 50 }).find((i) => i.tool === t.name);
  const sample = last ? store.invocation(last.id)?.upstream?.response?.body : undefined;
  return generateToolDocs(app, t, sample);
});

/**
 * Playground por mensagem: a IA (OpenAI) lê a mensagem, decide os argumentos e chama a tool de verdade
 * com a conexão escolhida (laboratório por padrão); depois responde com base no retorno.
 */
fastify.post<{ Params: { id: string; toolId: string } }>('/api/apps/:id/tools/:toolId/ai-test', async (req) => {
  const app = getApp(req.params.id);
  const t = getTool(app, req.params.toolId);
  const b = z.object({ message: z.string().trim().min(1).max(4000), connectionId: z.string().optional() }).parse(req.body ?? {});
  const conn = b.connectionId ? getConnection(b.connectionId) : store.labConnection(app.id);
  if (conn && conn.appId !== app.id) throw Object.assign(new Error('Vínculo é de outro app'), { statusCode: 400 });
  const target = targetFor(app, conn);
  return testToolWithMessage(t, visibleSchema(t, target), b.message, (args) => callUpstream(target, t, args));
});

/** Playground: executa a tool contra o upstream sem passar pelo MCP. */
fastify.post<{ Params: { id: string; toolId: string } }>('/api/apps/:id/tools/:toolId/test', async (req) => {
  const app = getApp(req.params.id);
  const t = getTool(app, req.params.toolId);
  const b = z.object({ args: z.record(z.string(), z.unknown()).default({}), connectionId: z.string().optional() }).parse(req.body ?? {});
  // Testa com a credencial/URL de um cliente vinculado, ou sem credencial na URL base padrão
  const conn = b.connectionId ? getConnection(b.connectionId) : store.labConnection(app.id);
  if (conn && conn.appId !== app.id) throw Object.assign(new Error('Vínculo é de outro app'), { statusCode: 400 });
  return callUpstream(targetFor(app, conn), t, b.args);
});

/* ------------------------- cherry / invocações ------------------------ */

/* ------------------------------- nexus -------------------------------- */

fastify.get('/api/nexus/status', async () => ({ configured: nexusConfigured(), ...nexusSessionInfo() }));

fastify.get<{ Querystring: { refresh?: string } }>('/api/nexus/organizations', async (req) => {
  const orgs = await listOrganizations(req.query.refresh === '1');
  const byOrg = new Map(store.clients().filter((c) => c.nexusOrgId).map((c) => [c.nexusOrgId!, c.id]));
  return orgs.map((o) => ({ ...o, clientId: byOrg.get(o.id) }));
});

/* ------------------------------ clientes ------------------------------ */

fastify.get('/api/clients', async () => store.clients().map(clientDto));

fastify.get<{ Params: { id: string } }>('/api/clients/:id', async (req) => clientDto(getClient(req.params.id)));

/**
 * Cadastra cliente. Só organizações existentes no Nexus: o id é conferido na API do Nexus
 * na hora do cadastro, e nome, nome fantasia e documento vêm de lá (não da tela).
 */
fastify.post('/api/clients', async (req, reply) => {
  const b = z
    .object({ nexusOrgId: z.string({ error: 'Escolha uma organização do Nexus.' }).trim().min(1, 'Escolha uma organização do Nexus.') })
    .passthrough()
    .parse(req.body ?? {});

  const dup = store.clients().find((c) => c.nexusOrgId === b.nexusOrgId);
  if (dup) throw Object.assign(new Error(`Essa organização já está cadastrada como "${dup.tradeName || dup.name}".`), { statusCode: 409 });

  // sempre confere no Nexus (lista atualizada); se o Nexus estiver fora, o cadastro não é feito
  const orgs = await listOrganizations(true).catch((e: any) => {
    throw Object.assign(new Error(`Não foi possível confirmar a organização no Nexus: ${e.message}`), { statusCode: e.statusCode ?? 502 });
  });
  const org = orgs.find((o) => o.id === b.nexusOrgId);
  if (!org) throw Object.assign(new Error('Organização não encontrada no Nexus. Só é possível cadastrar clientes do Nexus.'), { statusCode: 400 });

  const client: Client = {
    id: nanoid(12),
    slug: slugify(org.tradeName ?? org.name, (x) => RESERVED_CLIENT_SLUGS.has(x) || store.client(x), 'cliente'),
    name: org.name,
    tradeName: org.tradeName,
    document: org.document,
    nexusOrgId: org.id,
    createdAt: new Date().toISOString(),
  };
  await store.addClient(client);
  reply.code(201);
  return clientDto(client);
});

fastify.patch<{ Params: { id: string } }>('/api/clients/:id', async (req) => {
  const c = getClient(req.params.id);
  const b = z
    .object({
      // nome, nome fantasia e documento vêm do Nexus; aqui só o identificador da URL do MCP
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use letras minúsculas, números e hífen (até 40)')
        .optional(),
    })
    .parse(req.body);
  if (b.slug && b.slug !== c.slug) {
    if (RESERVED_CLIENT_SLUGS.has(b.slug)) throw Object.assign(new Error(`"${b.slug}" é reservado`), { statusCode: 400 });
    if (store.client(b.slug)) throw Object.assign(new Error('Já existe cliente com esse identificador'), { statusCode: 409 });
    c.slug = b.slug;
  }
  await store.save();
  return clientDto(c);
});

fastify.delete<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
  getClient(req.params.id);
  await store.removeClient(req.params.id);
  reply.code(204);
});

/* --------------------- vínculos cliente × MCP App --------------------- */

const ConnBody = z.object({
  baseUrl: z.string().url().or(z.literal('')).optional(),
  requireAccessKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  auth: AuthSchema.optional(),
});

fastify.post<{ Params: { id: string } }>('/api/clients/:id/connections', async (req, reply) => {
  const client = getClient(req.params.id);
  const b = ConnBody.extend({ appId: z.string() }).parse(req.body);
  const app = getApp(b.appId);
  if (store.findConnection(client.id, app.id))
    throw Object.assign(new Error(`O app "${app.name}" já está vinculado a este cliente.`), { statusCode: 409 });
  const conn: Connection = {
    id: nanoid(12),
    clientId: client.id,
    appId: app.id,
    // configuração individual do cliente: começa com a URL da documentação, sem credencial
    baseUrl: (b.baseUrl ?? app.baseUrl).replace(/\/+$/, ''),
    auth: b.auth ?? { type: 'none' },
    extraHeaders: b.extraHeaders ?? {},
    oauth: newOAuthClient(),
    requireAccessKey: b.requireAccessKey ?? true,
    enabled: b.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  await store.addConnection(conn);
  reply.code(201);
  return dto(req, conn);
});

fastify.get<{ Params: { id: string } }>('/api/connections/:id', async (req) => dto(req, connFor(req, req.params.id, 'view')));

fastify.patch<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
  const c = connFor(req, req.params.id, 'edit');
  const b = ConnBody.parse(req.body);
  if (b.baseUrl !== undefined) c.baseUrl = b.baseUrl.replace(/\/+$/, '');
  if (b.requireAccessKey !== undefined) c.requireAccessKey = b.requireAccessKey;
  if (b.enabled !== undefined) c.enabled = b.enabled;
  if (b.extraHeaders) c.extraHeaders = b.extraHeaders;
  if (b.auth) c.auth = mergeAuth(c.auth, b.auth);
  await store.save();
  return dto(req, c);
});

/** Gera novo client_id/client_secret e revoga os tokens emitidos com os antigos. */
fastify.post<{ Params: { id: string } }>('/api/connections/:id/rotate-credentials', async (req) => {
  const c = connFor(req, req.params.id, 'credentials');
  c.oauth = newOAuthClient();
  store.revokeTokens(c.id);
  await store.save();
  return dto(req, c);
});

fastify.post<{ Params: { id: string } }>('/api/connections/:id/revoke-tokens', async (req) => {
  const c = connFor(req, req.params.id, 'credentials');
  const revoked = store.revokeTokens(c.id);
  return { revoked, connection: dto(req, c) };
});

fastify.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
  const c = connFor(req, req.params.id, 'edit');
  if (c.lab) throw Object.assign(new Error('A conexão de laboratório faz parte do app e não pode ser removida.'), { statusCode: 400 });
  await store.removeConnection(req.params.id);
  reply.code(204);
});

/** Config pronta para o Cherry Studio / outros clientes MCP (o token vem do /oauth/token). */
fastify.get<{ Params: { id: string } }>('/api/connections/:id/client-config', async (req) => {
  const c = connFor(req, req.params.id, 'view');
  const app = getApp(c.appId);
  const client = c.lab ? LAB_CLIENT : getClient(c.clientId);
  const url = mcpUrlFor(client, app);
  const headers: Record<string, string> = c.requireAccessKey ? { Authorization: 'Bearer <TOKEN>' } : {};
  const key = `${client.slug}-${app.slug}`;
  return {
    url,
    headers,
    tokenUrl: TOKEN_URL,
    // Formato aceito pelo "Importar do JSON" do Cherry Studio e por outros clientes MCP
    mcpServers: { [key]: { type: 'streamableHttp', name: `${app.name} · ${clientLabel(client)}`, baseUrl: url, url, headers, isActive: true } },
  };
});

/* ------------------------- OAuth 2.0 (token) -------------------------- */

const oauthError = (reply: any, status: number, error: string, description: string) => {
  reply.code(status).header('cache-control', 'no-store').header('pragma', 'no-cache');
  if (status === 401) reply.header('www-authenticate', 'Basic realm="mcp-forge"');
  return reply.send({ error, error_description: description });
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Token endpoint OAuth 2.0 (RFC 6749 §4.4, client_credentials).
 * Credenciais no corpo (client_id/client_secret) ou em Authorization: Basic.
 * Devolve um Bearer token válido por OAUTH_TOKEN_TTL_SECONDS (padrão 24 h) para o endpoint MCP da conexão.
 */
fastify.post('/oauth/token', async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, string>;
  let clientId = body.client_id;
  let clientSecret = body.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (basic) {
    const [u, ...p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    clientId = decodeURIComponent(u);
    clientSecret = decodeURIComponent(p.join(':'));
  }
  if (body.grant_type !== 'client_credentials')
    return oauthError(reply, 400, 'unsupported_grant_type', 'Use grant_type=client_credentials.');
  if (!clientId || !clientSecret) return oauthError(reply, 400, 'invalid_request', 'Informe client_id e client_secret.');
  const conn = store.connectionByClientId(clientId);
  if (!conn || !safeEqual(clientSecret, conn.oauth.clientSecret)) return oauthError(reply, 401, 'invalid_client', 'client_id ou client_secret inválido.');
  if (!conn.enabled) return oauthError(reply, 400, 'invalid_client', 'Conexão desativada.');
  const t = store.issueToken(conn.id);
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
  return { access_token: t.token, token_type: 'Bearer', expires_in: t.expiresIn, expires_at: t.expiresAt, scope: 'mcp' };
});

/* ------------------------------- logs --------------------------------- */

fastify.get<{ Querystring: { app?: string; client?: string; id?: string; tool?: string; status?: string; from?: string; to?: string; limit?: string } }>(
  '/api/invocations',
  async (req) => {
    const q = req.query;
    return store.invocations({ ...q, limit: Math.min(Number(q.limit) || 200, 1000) });
  },
);

fastify.get<{ Params: { id: string } }>('/api/invocations/:id', async (req, reply) => {
  const inv = store.invocation(req.params.id);
  return inv ?? reply.code(404).send({ error: 'Requisição não encontrada' });
});

/* ------------------------------- MCP + web ----------------------------- */

registerMcpRoutes(fastify);

const webDist = process.env.WEB_DIST ?? path.resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
  await fastify.register(fastifyStatic, { root: webDist });
  fastify.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') || req.url.startsWith('/mcp') ? reply.code(404).send({ error: 'Não encontrado' }) : reply.sendFile('index.html'),
  );
}

await fastify.listen({ port: PORT, host: HOST });
fastify.log.info(`MCP Forge em ${PUBLIC_URL}`);
