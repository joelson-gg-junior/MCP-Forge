import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { customAlphabet } from 'nanoid';
import { LAB_CLIENT, store } from './store.js';
import { blockedHeaderArg, callUpstream, targetFor, type UpstreamTarget } from './upstream.js';
import type { App, Client, Connection, Invocation, Tool } from './types.js';

/** Código curto e legível para cada requisição (sem 0/O/1/I para evitar confusão). */
export const newRequestId = (() => {
  const gen = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);
  return () => `RQ-${gen()}`;
})();

const LOG_BODY_MAX = Number(process.env.LOG_BODY_MAX ?? 20_000);
const clip = (s: string | undefined) =>
  s === undefined || s.length <= LOG_BODY_MAX ? s : s.slice(0, LOG_BODY_MAX) + `\n… (truncado no log em ${LOG_BODY_MAX} caracteres)`;

/** inputSchema sem os headers que a conexão controla (credencial/headers extras): o modelo nem vê esses campos. */
export function visibleSchema(tool: Tool, target: UpstreamTarget) {
  const hidden = tool.params.filter((p) => p.in === 'header' && blockedHeaderArg(target, p.wireName ?? p.name)).map((p) => p.name);
  if (!hidden.length) return tool.inputSchema;
  const s = structuredClone(tool.inputSchema) as any;
  for (const h of hidden) delete s.properties?.[h];
  if (Array.isArray(s.required)) s.required = s.required.filter((r: string) => !hidden.includes(r));
  return s;
}

/** Cria um servidor MCP (stateless) com as tools aprovadas do app, usando a credencial do cliente. */
function buildServer(app: App, client: Client, conn: Connection) {
  const target = targetFor(app, conn);
  const server = new Server(
    { name: `${client.slug}-${app.slug}`, version: app.source.version || '1.0.0' },
    { capabilities: { tools: {} }, instructions: `Tools da API "${app.name}" para o cliente ${client.tradeName || client.name}. Base: ${target.baseUrl}` },
  );

  const live = () => app.tools.filter((t) => t.status === 'approved');

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: live().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: visibleSchema(t, target) as any,
      annotations: { title: `${t.method} ${t.path}`, readOnlyHint: t.readOnly, destructiveHint: t.method === 'DELETE' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const requestId = newRequestId();
    const at = new Date().toISOString();
    const started = Date.now();
    const mcpRequest = {
      http: { method: 'POST', url: extra?.requestInfo?.url?.pathname ?? `/mcp/${client.slug}/${app.slug}`, headers: safeHeaders(extra?.requestInfo?.headers) },
      body: { jsonrpc: '2.0', id: extra?.requestId, method: req.method, params: req.params },
    };
    const tool = live().find((t) => t.name === req.params.name);

    const finish = (result: { isError?: boolean; content: { type: 'text'; text: string }[] }, inv: Partial<Invocation>) => {
      const response = { ...result, _meta: { requestId } };
      store.logInvocation({
        id: requestId,
        at,
        appId: app.id,
        appSlug: app.slug,
        clientId: client.id,
        clientSlug: client.slug,
        clientName: client.tradeName || client.name,
        connectionId: conn.id,
        tool: req.params.name,
        toolId: tool?.id,
        status: null,
        ok: false,
        ms: Date.now() - started,
        ...inv,
        mcp: { request: mcpRequest, response },
      });
      return response;
    };

    if (!tool) {
      const msg = `Tool "${req.params.name}" não existe ou não está aprovada.`;
      return finish({ isError: true, content: [{ type: 'text', text: `${msg}\n\nCódigo da requisição: ${requestId}` }] }, { error: msg });
    }

    const r = await callUpstream(target, tool, (req.params.arguments ?? {}) as Record<string, unknown>);
    const upstream = r.request && {
      ...r.request,
      body: clip(r.request.body),
      response: r.error && r.status === null ? undefined : { status: r.status, headers: r.responseHeaders, body: clip(r.text) ?? '' },
    };
    const inv: Partial<Invocation> = { status: r.status, ok: r.ok, ms: r.ms, error: r.error, upstream };
    const footer = `\n\nCódigo da requisição: ${requestId}`;
    if (r.error) return finish({ isError: true, content: [{ type: 'text', text: `Erro ao chamar a API: ${r.error}${footer}` }] }, inv);
    return finish(
      { isError: !r.ok, content: [{ type: 'text', text: `HTTP ${r.status} — ${tool.method} ${r.url}\nCódigo da requisição: ${requestId}\n\n${r.text}` }] },
      inv,
    );
  });

  return server;
}

/** Headers da chamada MCP, sem credenciais e sem ruído de transporte. */
function safeHeaders(h?: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  const skip = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'sec-fetch-mode', 'accept-language']);
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v === undefined || skip.has(k)) continue;
    const val = Array.isArray(v) ? v.join(', ') : v;
    out[k] = k === 'authorization' ? val.replace(/^(Bearer\s+)(.{0,9}).*$/i, '$1$2••••') : val;
  }
  return out;
}

/** O Bearer token (emitido em /oauth/token) pertence a esta conexão e ainda vale? */
function tokenMatches(conn: Connection, header?: string) {
  if (!conn.requireAccessKey) return true;
  const m = (header ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const owner = store.tokenConnection(m[1]);
  if (!owner) return false;
  const a = Buffer.from(owner);
  const b = Buffer.from(conn.id);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerMcpRoutes(fastify: FastifyInstance) {
  const notFound = (reply: any, message: string) => reply.code(404).send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

  const handler = async (request: any, reply: any) => {
    // /mcp/:client/:app, /mcp/lab/:app (laboratório) ou /mcp/:slug (endereço antigo = laboratório)
    let app: App | undefined;
    let client: Client | undefined;
    let conn: Connection | undefined;
    if (request.params.app && request.params.client === LAB_CLIENT.slug) {
      app = store.app(request.params.app);
      conn = app && store.labConnection(app.id);
      client = LAB_CLIENT;
      if (!app || !conn) return notFound(reply, 'MCP App não encontrado');
    } else if (request.params.app) {
      client = store.client(request.params.client);
      if (!client) return notFound(reply, 'Cliente não encontrado');
      app = store.app(request.params.app);
      if (!app) return notFound(reply, 'MCP App não encontrado');
      conn = store.findConnection(client.id, app.id);
      if (!conn) return notFound(reply, `O app "${app.name}" não está vinculado ao cliente ${client.tradeName || client.name}`);
    } else {
      app = store.app(request.params.slug);
      conn = app && store.labConnection(app.id);
      client = LAB_CLIENT;
      if (!conn || !app || conn.legacyAppSlug !== app.slug) return notFound(reply, 'App não encontrado. Use /mcp/<cliente>/<app>.');
    }
    if (!conn.enabled) return reply.code(403).send({ jsonrpc: '2.0', error: { code: -32001, message: conn.lab ? 'Conexão de laboratório desativada' : 'Conexão desativada para este cliente' }, id: null });

    if (!tokenMatches(conn, request.headers.authorization))
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="mcp-forge", error="invalid_token", error_description="Gere um token em POST /oauth/token"')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Token inválido ou expirado. Gere um novo Bearer token em POST /oauth/token (client_credentials).' },
          id: null,
        });

    if (request.method !== 'POST') {
      // Modo stateless: sem stream SSE de servidor nem sessões para encerrar
      return reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST' }, id: null });
    }

    const server = buildServer(app, client, conn);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (e: any) {
      fastify.log.error(e);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null }));
      }
    }
  };

  fastify.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp/:client/:app', handler });
  fastify.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp/:slug', handler });
}
