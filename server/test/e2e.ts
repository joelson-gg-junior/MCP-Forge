/**
 * Teste ponta a ponta: sobe uma API mock, sobe o MCP Forge, importa specs,
 * aprova tools e conversa com o endpoint MCP usando o cliente oficial do SDK.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const UP = 9099;
const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const fx = (f: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf8');

// ---------------- API mock ----------------
const seen: any[] = [];
let nexusLogins = 0;
const aiCalls: any[] = [];
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ method: req.method, url: req.url, headers: req.headers, body });
  const u = new URL(req.url!, `http://x`);
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/v3/pet/7' && req.method === 'GET') return res.end(JSON.stringify({ id: 7, name: 'Rex', status: 'available' }));
  if (u.pathname === '/api/v3/pet/404') return (res.statusCode = 404), res.end(JSON.stringify({ message: 'Pet not found' }));
  if (u.pathname === '/api/v3/pet/findByStatus') return res.end(JSON.stringify([{ id: 1, status: u.searchParams.get('status') }]));
  if (u.pathname === '/api/v3/pet' && req.method === 'POST') return res.end(JSON.stringify({ created: JSON.parse(body) }));
  // OpenAI (geração de descrições por IA)
  if (u.pathname === '/openai/v1/chat/completions' && req.method === 'POST') {
    const b = JSON.parse(body);
    aiCalls.push({ headers: req.headers, body: b });
    if (req.headers.authorization !== 'Bearer sk-teste') return (res.statusCode = 401), res.end('{"error":{"message":"Incorrect API key"}}');
    const ok = (message: any) => res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    // teste por mensagem: 1ª chamada decide a tool, 2ª responde com o retorno
    if (b.tool_choice === 'none') {
      const toolMsg = b.messages.find((m: any) => m.role === 'tool');
      return ok({ role: 'assistant', content: `Resposta final baseada em: ${toolMsg.content.split('\n')[0]}` });
    }
    if (b.tool_choice === 'auto') {
      const id = /\d+/.exec(b.messages.at(-1).content)?.[0];
      if (!id) return ok({ role: 'assistant', content: 'Preciso do número do pet para consultar.' });
      const fn = b.tools[0].function;
      return ok({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: fn.name, arguments: JSON.stringify({ petId: Number(id) }) } }],
      });
    }
    const names = Object.keys(b.tools[0].function.parameters.properties.parameters.properties);
    const args = {
      description: 'Busca um pet pelo ID e retorna nome e status. Use quando o usuário informar o número do pet.',
      parameters: Object.fromEntries(names.map((n: string) => [n, `Descrição gerada para ${n}`])),
    };
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'salvar_documentacao', arguments: JSON.stringify(args) } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
  }
  // Nexus (login + organizações)
  if (u.pathname === '/nexus/api/v1/auth/login' && req.method === 'POST') {
    nexusLogins++;
    const b = JSON.parse(body || '{}');
    if (b.email !== 'teste@matrixgo.ai' || b.password !== 'senha') return (res.statusCode = 401), res.end('{"message":"Credenciais inválidas"}');
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return res.end(JSON.stringify({ user: { email: b.email }, accessToken: `eyJhbGciOiJIUzI1NiJ9.${payload}.assinatura` }));
  }
  if (u.pathname === '/nexus/api/v1/organizations') {
    if (!String(req.headers.authorization).startsWith('Bearer eyJ')) return (res.statusCode = 401), res.end('{}');
    return res.end(
      JSON.stringify({
        data: [
          { id: 'org-acme', socialName: 'ACME Telecom LTDA', tradeName: 'Acme Net', document: '12.345.678/0001-90', status: 'ACTIVE' },
          { id: 'org-beta', socialName: 'Beta Provedor SA', tradeName: null, document: '98.765.432/0001-10', status: 'ACTIVE' },
        ],
        meta: { page: 1, perPage: 500, total: 2, lastPage: 1 },
      }),
    );
  }
  // Páginas de documentação em HTML (descoberta da spec)
  if (u.pathname === '/api-docs') return (res.statusCode = 301), res.setHeader('location', '/api-docs/'), res.end();
  if (u.pathname === '/api-docs/') {
    res.setHeader('content-type', 'text/html');
    return res.end(
      '<!DOCTYPE html><html><head><title>Swagger UI</title><link rel="stylesheet" href="./swagger-ui.css"></head>' +
        '<body><div id="swagger-ui"></div><script src="./swagger-ui-bundle.js"></script>' +
        '<script src="./swagger-ui-standalone-preset.js"></script><script src="./swagger-ui-init.js"></script></body></html>',
    );
  }
  if (u.pathname === '/api-docs/swagger-ui-init.js') {
    res.setHeader('content-type', 'application/javascript');
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Embutida API', version: '3.0.0', description: 'Texto com { chaves } e "aspas" para testar o parser' },
      servers: [{ url: '/api/v3' }],
      paths: { '/pet/{id}': { get: { operationId: 'getPet', summary: 'Busca pet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] } } },
    };
    return res.end(
      `window.onload = function() {\n  var url = window.location.search.match(/url=([^&]+)/);\n  var options = {\n  "swaggerDoc": ${JSON.stringify(doc, null, 2)},\n  "customOptions": {}\n};\n  url = options.swaggerUrl || url;\n  SwaggerUIBundle({ spec: options.swaggerDoc, dom_id: '#swagger-ui' });\n}`,
    );
  }
  if (u.pathname === '/redoc') {
    res.setHeader('content-type', 'text/html');
    return res.end('<html><body><redoc spec-url="/specs/openapi.yaml"></redoc><script src="https://cdn.redoc.ly/redoc.standalone.js"></script></body></html>');
  }
  if (u.pathname === '/specs/openapi.yaml') return res.end(fx('petstore-openapi3.yaml'));
  if (u.pathname.startsWith('/erp/clientes/')) return res.end(JSON.stringify({ cpf: u.pathname.split('/').pop(), ativo: u.searchParams.get('ativo') }));
  res.statusCode = 404;
  res.end('{}');
});
await new Promise<void>((r) => upstream.listen(UP, r));

// ---------------- MCP Forge ----------------
const dataDir = mkdtempSync(path.join(tmpdir(), 'mcpf-'));
// Banco no formato antigo (credencial e chave no App) para testar a migração
writeFileSync(
  path.join(dataDir, 'db.json'),
  JSON.stringify({
    apps: [
      {
        id: 'legacy1', slug: 'legado', name: 'Legado', baseUrl: `http://localhost:${UP}/api/v3`,
        auth: { type: 'bearer', token: 'tok-legado' }, extraHeaders: {}, accessKey: 'mcpf_legacy_key', requireAccessKey: true,
        source: { kind: 'openapi3' }, createdAt: new Date().toISOString(),
        tools: [{ id: 't1', name: 'get_pet', description: 'Busca pet', method: 'GET', path: '/pet/{id}', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, 'x-api-key': { type: 'string' } }, required: ['id', 'x-api-key'] }, params: [{ name: 'id', in: 'path' }, { name: 'x-api-key', in: 'header', wireName: 'x-api-key' }], status: 'approved', readOnly: true, updatedAt: new Date().toISOString() }],
      },
    ],
    invocations: [{ at: new Date().toISOString(), appSlug: 'legado', tool: 'get_pet', status: 200, ok: true, ms: 3 }],
  }),
);
const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    LOG_LEVEL: 'warn',
    WEB_DIST: '/nonexistent',
    ENV_FILE: '/nonexistent',
    NEXUS_API_URL: `http://localhost:${UP}/nexus`,
    NEXUS_EMAIL: 'teste@matrixgo.ai',
    NEXUS_PASSWORD: 'senha',
    NEXUS_TOKEN: '',
    OPENAI_API_KEY: 'sk-teste',
    OPENAI_BASE_URL: `http://localhost:${UP}/openai/v1`,
    OPENAI_MODEL: 'gpt-teste',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

let cookie = '';
const api = async (method: string, url: string, body?: unknown, asCookie = cookie) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(asCookie ? { cookie: asCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, headers: r.headers };
};

/** Faz login e devolve o cookie de sessão. */
const login = async (username: string, password: string) => {
  const r = await api('POST', '/api/auth/login', { username, password }, '');
  if (r.status !== 200) return { status: r.status, cookie: '', json: r.json };
  return { status: 200, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], json: r.json };
};

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    process.exitCode = 1;
  }
};

try {
  console.log('MCP Forge — e2e');

  await test('acesso: API exige login; admin master joelson entra', async () => {
    assert.equal((await api('GET', '/api/apps', undefined, '')).status, 401);
    assert.equal((await api('GET', '/api/health', undefined, '')).status, 200);
    assert.equal((await login('joelson', 'errada')).status, 401);
    const l = await login('joelson', 'joel777');
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.match(l.cookie, /^mcpf_session=/);
    assert.equal(l.json.master, true);
    assert.equal(l.json.profileName, 'Administrador');
    assert.ok(l.json.permissions.includes('access.manage'));
    cookie = l.cookie;
  });

  let pet: any;

  await test('importa OpenAPI 3 (YAML) com $ref circular', async () => {
    const r = await api('POST', '/api/apps/import', { content: fx('petstore-openapi3.yaml') });
    assert.equal(r.status, 201);
    pet = r.json.app;
    assert.equal(pet.slug, 'petstore-mock');
    assert.equal(pet.baseUrl, 'http://localhost:9099/api/v3');
    assert.deepEqual(pet.tools.map((t: any) => t.name).sort(), ['add_pet', 'delete_pet', 'find_pets_by_status', 'get_pet_by_id']);
    const add = pet.tools.find((t: any) => t.name === 'add_pet');
    assert.equal(add.inputSchema.required[0], 'body');
    assert.match(add.inputSchema.properties.body.properties.parent.description, /circular/);
    assert.deepEqual(add.inputSchema.properties.body.properties.status.type, ['string', 'null']);
  });

  await test('importa Swagger 2.0', async () => {
    const r = await api('POST', '/api/apps/import', { content: fx('swagger2.json') });
    assert.equal(r.json.app.baseUrl, 'http://localhost:9099/legacy');
    const upd = r.json.app.tools.find((t: any) => t.name === 'update_user');
    assert.ok(upd.inputSchema.properties.id && upd.inputSchema.properties.body);
  });

  let erp: any;
  await test('importa Postman v2.1 (pastas, :vars, query, body raw)', async () => {
    const r = await api('POST', '/api/apps/import', { content: fx('postman.json') });
    erp = r.json.app;
    assert.equal(erp.baseUrl, 'http://localhost:9099/erp');
    const buscar = erp.tools.find((t: any) => t.path === '/clientes/{cpf}');
    assert.equal(buscar.name, 'clientes_buscar_cliente_por_cpf');
    assert.deepEqual(buscar.inputSchema.required, ['cpf']);
    assert.ok(buscar.inputSchema.properties.ativo);
    const criar = erp.tools.find((t: any) => t.method === 'POST');
    assert.equal(criar.inputSchema.properties.body.properties.assunto.type, 'string');
  });

  await test('descobre spec embutida no Swagger UI (swagger-ui-express)', async () => {
    const r = await api('POST', '/api/apps/import', { url: `http://localhost:${UP}/api-docs`, name: 'Swagger UI embutido' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.app.baseUrl, `http://localhost:${UP}/api/v3`);
    assert.deepEqual(r.json.app.tools.map((t: any) => t.name), ['get_pet']);
  });

  await test('descobre spec referenciada no Redoc (spec-url)', async () => {
    const r = await api('POST', '/api/apps/import', { url: `http://localhost:${UP}/redoc`, name: 'Via Redoc' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.app.tools.length, 4);
  });

  await test('rejeita HTML com mensagem clara', async () => {
    const r = await api('POST', '/api/apps/import', { content: '<html><body>docs</body></html>' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /retornou HTML/);
  });

  const mcpClient = async (path: string, key?: string) => {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${path}`), {
      requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
    });
    await client.connect(transport);
    return client;
  };

  /** Gera um Bearer token via OAuth 2.0 client_credentials para a conexão. */
  const tok = async (conn: any) => {
    const r = await api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: conn.oauth.clientId, client_secret: conn.oauth.clientSecret });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.access_token as string;
  };

  /* ------------------------- Nexus e clientes ------------------------- */

  await test('Nexus: lista organizações e só faz login de novo quando o token expirar', async () => {
    const r1 = await api('GET', '/api/nexus/organizations');
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.deepEqual(r1.json.map((o: any) => o.name), ['ACME Telecom LTDA', 'Beta Provedor SA']);
    assert.equal(r1.json[0].tradeName, 'Acme Net');
    assert.equal(r1.json[0].document, '12.345.678/0001-90');
    await api('GET', '/api/nexus/organizations?refresh=1');
    await api('GET', '/api/nexus/organizations?refresh=1');
    assert.equal(nexusLogins, 1, 'token válido deve ser reaproveitado');
    assert.ok(existsSync(path.join(dataDir, 'nexus-session.json')), 'sessão salva para sobreviver a reinícios');
    const st = (await api('GET', '/api/nexus/status')).json;
    assert.equal(st.configured, true);
    assert.equal(st.loggedIn, true);
  });

  let acme: any;
  let beta: any;
  await test('cadastra cliente a partir de organização do Nexus', async () => {
    const r = await api('POST', '/api/clients', { nexusOrgId: 'org-acme' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    acme = r.json;
    assert.equal(acme.name, 'ACME Telecom LTDA');
    assert.equal(acme.slug, 'acme-net');
    assert.equal(acme.document, '12.345.678/0001-90');
    const dup = await api('POST', '/api/clients', { nexusOrgId: 'org-acme' });
    assert.equal(dup.status, 409);
    // só organizações do Nexus
    const manual = await api('POST', '/api/clients', { name: 'Cliente Manual LTDA' });
    assert.equal(manual.status, 400);
    const fake = await api('POST', '/api/clients', { nexusOrgId: 'org-inexistente', name: 'Inventado' });
    assert.equal(fake.status, 400);
    assert.match(fake.json.error, /não encontrada no Nexus/);
    // dados vêm do Nexus, não do corpo da requisição
    const spoof = await api('PATCH', `/api/clients/${acme.id}`, { name: 'Outro Nome' });
    assert.equal(spoof.json.name, 'ACME Telecom LTDA');
    const orgs = (await api('GET', '/api/nexus/organizations')).json;
    assert.equal(orgs.find((o: any) => o.id === 'org-acme').clientId, acme.id);
    beta = (await api('POST', '/api/clients', { nexusOrgId: 'org-beta' })).json;
    assert.equal(beta.slug, 'beta-provedor-sa');
  });

  await test('migração: credencial antiga vira a configuração de laboratório do app', async () => {
    const clients = (await api('GET', '/api/clients')).json;
    assert.ok(!clients.some((c: any) => c.slug === 'migrado'), 'não cria cliente "migrado"');
    const app = (await api('GET', '/api/apps/legado')).json;
    const legTool = app.tools[0];
    assert.deepEqual(legTool.params.map((p: any) => p.name), ['id'], 'header de credencial removido das tools antigas');
    assert.deepEqual(legTool.inputSchema.required, ['id']);
    assert.equal(app.auth, undefined);
    assert.equal(app.accessKey, undefined);
    const lab = (await api('GET', `/api/connections/${app.labConnectionId}`)).json;
    assert.equal(lab.lab, true);
    assert.equal(lab.auth.type, 'bearer');
    assert.equal(lab.mcpUrl, `http://localhost:${PORT}/mcp/lab/legado`);
    assert.equal(lab.legacyUrl, `http://localhost:${PORT}/mcp/legado`);
    // a chave estática antiga não é mais aceita: só Bearer token do OAuth
    await assert.rejects(mcpClient('legado', 'mcpf_legacy_key'));
    const t = await tok(lab);
    const c = await mcpClient('legado', t);
    const r: any = await c.callTool({ name: 'get_pet', arguments: { id: 7 } });
    await c.close();
    assert.match(r.content[0].text, /"name": "Rex"/);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer tok-legado');
    const c2 = await mcpClient('lab/legado', t);
    assert.equal((await c2.listTools()).tools.length, 1);
    await c2.close();
  });

  await test('todo app importado tem conexão de laboratório própria', async () => {
    const app = (await api('GET', `/api/apps/${pet.id}`)).json;
    const lab = (await api('GET', `/api/connections/${app.labConnectionId}`)).json;
    assert.equal(lab.lab, true);
    assert.equal(lab.client.slug, 'lab');
    assert.equal(lab.baseUrl, `http://localhost:${UP}/api/v3`);
    assert.match(lab.oauth.clientId, /^mcpc_/);
    assert.match(lab.oauth.clientSecret, /^mcps_/);
    assert.equal(lab.oauth.tokenUrl, `http://localhost:${PORT}/oauth/token`);
    assert.match(lab.oauth.curl, /^curl -X POST 'http:\/\/localhost:8099\/oauth\/token'/);
    assert.ok(lab.oauth.curl.includes(`client_secret=${lab.oauth.clientSecret}`));
    assert.equal(app.connections.length, 0, 'laboratório não aparece como cliente');
    assert.equal((await api('DELETE', `/api/connections/${lab.id}`)).status, 400);
  });

  let acmePet: any;
  let betaPet: any;
  await test('vincula MCP App ao cliente com credencial própria', async () => {
    const r = await api('POST', `/api/clients/${acme.id}/connections`, {
      appId: pet.id,
      auth: { type: 'apiKey', headerName: 'X-API-Key', value: 's3cr3t' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    acmePet = r.json;
    assert.equal(acmePet.mcpUrl, `http://localhost:${PORT}/mcp/acme-net/petstore-mock`);
    assert.equal(acmePet.auth.value, '••••••');
    assert.match(acmePet.oauth.clientId, /^mcpc_/);
    assert.equal(acmePet.baseUrl, `http://localhost:${UP}/api/v3`, 'começa com a URL da documentação');
    assert.equal((await api('POST', `/api/clients/${acme.id}/connections`, { appId: pet.id })).status, 409);
    betaPet = (await api('POST', `/api/clients/${beta.id}/connections`, { appId: pet.id, auth: { type: 'bearer', token: 'tok-beta' } })).json;
    assert.notEqual(betaPet.oauth.clientId, acmePet.oauth.clientId);
    assert.notEqual(betaPet.oauth.clientSecret, acmePet.oauth.clientSecret);
    const full = (await api('GET', `/api/apps/${pet.id}`)).json;
    assert.equal(full.connections.length, 2);
  });

  let acmeTok: string;
  let betaTok: string;
  await test('OAuth 2.0: token endpoint client_credentials', async () => {
    const bad = await api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: acmePet.oauth.clientId, client_secret: 'errado' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'invalid_client');
    const grant = await api('POST', '/oauth/token', { grant_type: 'password', client_id: acmePet.oauth.clientId, client_secret: acmePet.oauth.clientSecret });
    assert.equal(grant.status, 400);
    assert.equal(grant.json.error, 'unsupported_grant_type');

    // formato padrão: x-www-form-urlencoded
    const form = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: acmePet.oauth.clientId, client_secret: acmePet.oauth.clientSecret }),
    });
    const fj: any = await form.json();
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('cache-control'), 'no-store');
    assert.equal(fj.token_type, 'Bearer');
    assert.equal(fj.expires_in, 86400, 'token vale 24 horas');
    assert.match(fj.access_token, /^mcpt_/);
    const exp = Date.parse(fj.expires_at) - Date.now();
    assert.ok(exp > 86_000_000 && exp <= 86_400_000);
    acmeTok = fj.access_token;

    // credenciais em Authorization: Basic
    const basic = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${betaPet.oauth.clientId}:${betaPet.oauth.clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });
    assert.equal(basic.status, 200);
    betaTok = ((await basic.json()) as any).access_token;
    const st = (await api('GET', `/api/connections/${acmePet.id}`)).json;
    assert.equal(st.oauth.activeTokens, 1);
  });

  await test('MCP exige Bearer token da própria conexão', async () => {
    await assert.rejects(mcpClient('acme-net/petstore-mock'));
    await assert.rejects(mcpClient('acme-net/petstore-mock', 'errada'));
    await assert.rejects(mcpClient('acme-net/petstore-mock', acmePet.oauth.clientSecret), 'secret não é token');
    await assert.rejects(mcpClient('acme-net/petstore-mock', betaTok), 'token de outro cliente não serve');
    const lab = (await api('GET', `/api/connections/${(await api('GET', `/api/apps/${pet.id}`)).json.labConnectionId}`)).json;
    await assert.rejects(mcpClient('acme-net/petstore-mock', await tok(lab)), 'token do laboratório não serve no cliente');
    await assert.rejects(mcpClient('lab/petstore-mock', acmeTok), 'token do cliente não serve no laboratório');
    await assert.rejects(mcpClient('petstore-mock', acmeTok), 'sem endereço antigo para apps novos');
    const r = await fetch(`${BASE}/mcp/acme-net/petstore-mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') ?? '', /Bearer .*invalid_token/);
  });

  await test('MCP só expõe tools aprovadas', async () => {
    const c = await mcpClient('acme-net/petstore-mock', acmeTok);
    assert.equal((await c.listTools()).tools.length, 0);
    await c.close();
    const ids = pet.tools.filter((t: any) => t.name !== 'delete_pet').map((t: any) => t.id);
    const r = await api('POST', `/api/apps/${pet.id}/tools/bulk`, { ids, status: 'approved' });
    assert.equal(r.json.updated, 3);
    const c2 = await mcpClient('acme-net/petstore-mock', acmeTok);
    const tools = (await c2.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add_pet', 'find_pets_by_status', 'get_pet_by_id']);
    assert.equal(tools.find((t) => t.name === 'get_pet_by_id')!.annotations?.readOnlyHint, true);
    await c2.close();
  });

  await test('callTool: path, query, body e auth upstream do cliente', async () => {
    const c = await mcpClient('acme-net/petstore-mock', acmeTok);
    const r1: any = await c.callTool({ name: 'get_pet_by_id', arguments: { petId: 7 } });
    assert.equal(r1.isError, false);
    assert.match(r1.content[0].text, /HTTP 200[\s\S]*"name": "Rex"/);
    assert.equal(seen.at(-1).headers['x-api-key'], 's3cr3t');

    const r2: any = await c.callTool({ name: 'find_pets_by_status', arguments: { status: 'sold' } });
    assert.match(r2.content[0].text, /"status": "sold"/);

    const r3: any = await c.callTool({ name: 'add_pet', arguments: { body: { name: 'Bolt' } } });
    assert.match(r3.content[0].text, /"name": "Bolt"/);
    assert.equal(seen.at(-1).headers['content-type'], 'application/json');

    const r4: any = await c.callTool({ name: 'get_pet_by_id', arguments: { petId: 404 } });
    assert.equal(r4.isError, true);

    const r5: any = await c.callTool({ name: 'delete_pet', arguments: { petId: 1 } });
    assert.equal(r5.isError, true);
    assert.match(r5.content[0].text, /não está aprovada/);
    await c.close();

    // outro cliente, mesmo app: credencial dele
    const cb = await mcpClient('beta-provedor-sa/petstore-mock', betaTok);
    await cb.callTool({ name: 'get_pet_by_id', arguments: { petId: 7 } });
    await cb.close();
    assert.equal(seen.at(-1).headers.authorization, 'Bearer tok-beta');
    assert.equal(seen.at(-1).headers['x-api-key'], undefined);
  });

  await test('URL base por cliente', async () => {
    await api('PATCH', `/api/connections/${betaPet.id}`, { baseUrl: `http://localhost:${UP}/erp` });
    const cb = await mcpClient('beta-provedor-sa/petstore-mock', betaTok);
    await cb.callTool({ name: 'get_pet_by_id', arguments: { petId: 7 } });
    await cb.close();
    assert.equal(seen.at(-1).url, '/erp/pet/7');
    await api('PATCH', `/api/connections/${betaPet.id}`, { baseUrl: '' });
  });

  await test('bloqueia path traversal para fora da URL base', async () => {
    const c = await mcpClient('acme-net/petstore-mock', acmeTok);
    await c.callTool({ name: 'get_pet_by_id', arguments: { petId: '../../../etc' } });
    // encodeURIComponent mantém o valor dentro do segmento
    assert.ok(!seen.at(-1).url.includes('/etc') || seen.at(-1).url.startsWith('/api/v3/pet/'));
    await c.close();
  });

  await test('segredos mascarados na API e preservados no PATCH', async () => {
    const r = await api('GET', `/api/connections/${acmePet.id}`);
    assert.equal(r.json.auth.value, '••••••');
    await api('PATCH', `/api/connections/${acmePet.id}`, { auth: { type: 'apiKey', headerName: 'X-API-Key', value: '••••••' } });
    const c = await mcpClient('acme-net/petstore-mock', acmeTok);
    await c.callTool({ name: 'get_pet_by_id', arguments: { petId: 7 } });
    assert.equal(seen.at(-1).headers['x-api-key'], 's3cr3t');
    await c.close();
  });

  await test('gerar novas credenciais revoga tokens; desativar bloqueia', async () => {
    const old = betaPet;
    const rot = (await api('POST', `/api/connections/${betaPet.id}/rotate-credentials`)).json;
    assert.notEqual(rot.oauth.clientId, old.oauth.clientId);
    assert.notEqual(rot.oauth.clientSecret, old.oauth.clientSecret);
    await assert.rejects(mcpClient('beta-provedor-sa/petstore-mock', betaTok), 'token antigo revogado');
    const r = await api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: old.oauth.clientId, client_secret: old.oauth.clientSecret });
    assert.equal(r.status, 401, 'credencial antiga recusada');
    betaPet = rot;
    betaTok = await tok(betaPet);
    const c = await mcpClient('beta-provedor-sa/petstore-mock', betaTok);
    await c.close();

    await api('PATCH', `/api/connections/${betaPet.id}`, { enabled: false });
    await assert.rejects(mcpClient('beta-provedor-sa/petstore-mock', betaTok));
    assert.equal((await api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: betaPet.oauth.clientId, client_secret: betaPet.oauth.clientSecret })).status, 400);
    await api('PATCH', `/api/connections/${betaPet.id}`, { enabled: true });

    const rv = (await api('POST', `/api/connections/${betaPet.id}/revoke-tokens`)).json;
    assert.equal(rv.revoked, 1);
    await assert.rejects(mcpClient('beta-provedor-sa/petstore-mock', betaTok));
    betaTok = await tok(betaPet);
  });

  await test('playground testa com a credencial do cliente escolhido', async () => {
    const t = pet.tools.find((x: any) => x.name === 'get_pet_by_id');
    const r = await api('POST', `/api/apps/${pet.id}/tools/${t.id}/test`, { args: { petId: 7 }, connectionId: betaPet.id });
    assert.equal(r.json.status, 200);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer tok-beta');
  });

  await test('editar tool aprovada volta para draft', async () => {
    const t = pet.tools.find((x: any) => x.name === 'get_pet_by_id');
    const r = await api('PATCH', `/api/apps/${pet.id}/tools/${t.id}`, { description: 'Busca um pet pelo ID numérico e retorna nome e status.' });
    assert.equal(r.json.status, 'draft');
  });

  await test('Postman: callTool com :cpf e query (sem chave de acesso)', async () => {
    const t = erp.tools.find((x: any) => x.path === '/clientes/{cpf}');
    await api('PATCH', `/api/apps/${erp.id}/tools/${t.id}`, { status: 'approved' });
    const conn = (await api('POST', `/api/clients/${acme.id}/connections`, { appId: erp.id, requireAccessKey: false })).json;
    assert.equal(conn.requireAccessKey, false);
    const c = await mcpClient(`acme-net/${erp.slug}`);
    const r: any = await c.callTool({ name: t.name, arguments: { cpf: '12345678900', ativo: 'true' } });
    assert.match(r.content[0].text, /"cpf": "12345678900"/);
    assert.equal(seen.at(-1).url, '/erp/clientes/12345678900?ativo=true');
    await c.close();
  });

  await test('client-config para o Cherry Studio (por cliente)', async () => {
    const r = await api('GET', `/api/connections/${acmePet.id}/client-config`);
    const cfg = r.json.mcpServers['acme-net-petstore-mock'];
    assert.equal(cfg.type, 'streamableHttp');
    assert.equal(cfg.baseUrl, `http://localhost:${PORT}/mcp/acme-net/petstore-mock`);
    assert.equal(cfg.headers.Authorization, 'Bearer <TOKEN>');
    assert.equal(r.json.tokenUrl, `http://localhost:${PORT}/oauth/token`);
    assert.equal(cfg.name, 'Petstore Mock · Acme Net');
  });

  await test('reimport detecta mudança de contrato', async () => {
    const changedSpec = fx('petstore-openapi3.yaml').replace(
      '- { name: status, in: query, required: false, schema: { type: string, enum: [available, pending, sold] } }',
      '- { name: status, in: query, required: false, schema: { type: string } }\n        - { name: limit, in: query, schema: { type: integer } }',
    );
    const r = await api('POST', `/api/apps/${pet.id}/reimport`, { content: changedSpec });
    assert.deepEqual(r.json.changed, ['find_pets_by_status']);
    assert.equal(r.json.app.tools.find((t: any) => t.name === 'find_pets_by_status').status, 'draft');
  });

  await test('registra invocações', async () => {
    const r = await api('GET', `/api/invocations?app=${pet.slug}`);
    assert.ok(r.json.length >= 5);
  });

  await test('logs: código da requisição no retorno do MCP e detalhe com curl', async () => {
    const t = pet.tools.find((x: any) => x.name === 'get_pet_by_id');
    await api('PATCH', `/api/apps/${pet.id}/tools/${t.id}`, { status: 'approved' });
    const c = await mcpClient('acme-net/petstore-mock', acmeTok);
    const res: any = await c.callTool({ name: 'get_pet_by_id', arguments: { petId: 7 } });
    await c.close();
    const code = res._meta?.requestId;
    assert.match(code, /^RQ-[A-Z2-9]{8}$/);
    assert.ok(res.content[0].text.includes(`Código da requisição: ${code}`));

    const list = await api('GET', `/api/invocations?id=${code}`);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].tool, 'get_pet_by_id');
    assert.equal(list.json[0].clientSlug, 'acme-net');
    assert.equal(list.json[0].clientName, 'Acme Net');
    assert.equal(list.json[0].mcp, undefined); // listagem é resumida

    const d = (await api('GET', `/api/invocations/${code}`)).json;
    assert.equal(d.mcp.request.http.url, '/mcp/acme-net/petstore-mock');
    assert.equal(d.mcp.request.body.method, 'tools/call');
    assert.deepEqual(d.mcp.request.body.params.arguments, { petId: 7 });
    assert.match(d.mcp.request.http.headers.authorization, /^Bearer mcpt_.{4}••••$/);
    assert.equal(d.mcp.response._meta.requestId, code);
    assert.equal(d.upstream.url, `http://localhost:${UP}/api/v3/pet/7`);
    assert.match(d.upstream.curl, /^curl -X GET 'http:\/\/localhost:9099\/api\/v3\/pet\/7'/);
    assert.ok(d.upstream.curl.includes(`-H 'X-API-Key: ••••'`));
    assert.ok(!JSON.stringify(d).includes('s3cr3t'), 'segredo não pode aparecer no log');
    assert.equal(d.upstream.response.status, 200);
    assert.match(d.upstream.response.body, /"name": "Rex"/);
  });

  await test('logs: filtros por cliente, app, tool, status e data/hora', async () => {
    const q = (s: string) => api('GET', `/api/invocations?${s}`).then((r) => r.json as any[]);
    assert.ok((await q(`app=${pet.slug}&status=404`)).every((i) => i.status === 404));
    assert.ok((await q(`app=${pet.slug}&status=404`)).length >= 1);
    assert.ok((await q('status=2xx')).every((i) => i.status >= 200 && i.status < 300));
    assert.ok((await q('status=erro')).every((i) => !i.ok));
    assert.ok((await q('tool=find_pets')).every((i) => i.tool === 'find_pets_by_status'));
    assert.equal((await q(`app=${erp.slug}&tool=get_pet`)).length, 0);
    const beta = await q('client=beta-provedor-sa');
    assert.ok(beta.length >= 2 && beta.every((i) => i.clientSlug === 'beta-provedor-sa'));
    assert.ok((await q(`client=${acme.id}`)).every((i) => i.clientSlug === 'acme-net'));
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await q(`from=${encodeURIComponent(future)}`)).length, 0);
    const past = new Date(Date.now() - 600_000).toISOString();
    assert.ok((await q(`from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)).length >= 6);
    assert.equal((await api('GET', '/api/invocations/RQ-NAOEXISTE')).status, 404);
  });

  await test('header de credencial não duplica (x-api-key da collection Postman)', async () => {
    const collection = {
      info: { name: 'Header API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Buscar pet',
          request: {
            method: 'GET',
            header: [
              { key: 'x-api-key', value: 'sua_chave_api' },
              { key: 'X-Tenant', value: 'abc', description: 'Tenant' },
            ],
            url: { raw: `http://localhost:${UP}/api/v3/pet/7`, host: [`localhost:${UP}`], path: ['api', 'v3', 'pet', '7'], protocol: 'http' },
          },
        },
      ],
    };
    const imp = await api('POST', '/api/apps/import', { content: JSON.stringify(collection) });
    assert.equal(imp.status, 201, JSON.stringify(imp.json));
    const app = imp.json.app;
    assert.ok(imp.json.warnings.some((w: string) => /x-api-key.*credencial/.test(w)));
    const tool = app.tools[0];
    assert.ok(!tool.params.some((p: any) => p.wireName === 'x-api-key'), 'x-api-key não vira parâmetro');
    assert.ok(tool.params.some((p: any) => p.wireName === 'X-Tenant'));
    await api('PATCH', `/api/apps/${app.id}/tools/${tool.id}`, { status: 'approved' });
    await api('PATCH', `/api/connections/${app.labConnectionId}`, {
      baseUrl: `http://localhost:${UP}`,
      auth: { type: 'apiKey', headerName: 'X-API-Key', value: 'chave-real' },
      extraHeaders: { 'x-tenant': 'fixo' },
    });
    const lab = (await api('GET', `/api/connections/${app.labConnectionId}`)).json;
    const c = await mcpClient(`lab/${app.slug}`, await tok(lab));
    const listed = (await c.listTools()).tools[0];
    assert.ok(!('X-Tenant' in (listed.inputSchema.properties ?? {})), 'header definido pela conexão some do schema');
    // mesmo que o modelo envie os headers, vale o da conexão, uma vez só
    const r: any = await c.callTool({ name: tool.name, arguments: { 'x-api-key': 'sua_chave_api', 'X-Tenant': 'outro' } });
    await c.close();
    assert.match(r.content[0].text, /HTTP 200/);
    const h = seen.at(-1).headers;
    assert.equal(h['x-api-key'], 'chave-real');
    assert.equal(h['x-tenant'], 'fixo');
    const d = (await api('GET', `/api/invocations/${r._meta.requestId}`)).json;
    assert.equal((d.upstream.curl.match(/x-api-key/gi) ?? []).length, 1, 'curl com um único x-api-key');
  });

  await test('IA gera descrição da tool e dos parâmetros (sem salvar)', async () => {
    const st = (await api('GET', '/api/ai/status')).json;
    assert.deepEqual(st, { configured: true, model: 'gpt-teste' });
    const t = pet.tools.find((x: any) => x.name === 'get_pet_by_id');
    const before = (await api('GET', `/api/apps/${pet.id}`)).json.tools.find((x: any) => x.id === t.id);
    const r = await api('POST', `/api/apps/${pet.id}/tools/${t.id}/ai-describe`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.description, /Busca um pet/);
    assert.equal(r.json.params.petId, 'Descrição gerada para petId');
    assert.equal(r.json.model, 'gpt-teste');
    const call = aiCalls.at(-1);
    assert.equal(call.body.model, 'gpt-teste');
    assert.deepEqual(call.body.tool_choice, { type: 'function', function: { name: 'salvar_documentacao' } });
    assert.equal(call.body.messages[0].role, 'system');
    const prompt = call.body.messages[1].content;
    assert.match(prompt, /GET \/pet\/\{petId\}/);
    assert.match(prompt, /Exemplo real de resposta/, 'usa resposta real dos logs como contexto');
    const after = (await api('GET', `/api/apps/${pet.id}`)).json.tools.find((x: any) => x.id === t.id);
    assert.equal(after.description, before.description, 'só sugere, não salva');
  });

  await test('IA testa a tool a partir de uma mensagem', async () => {
    const t = pet.tools.find((x: any) => x.name === 'get_pet_by_id');
    const r = await api('POST', `/api/apps/${pet.id}/tools/${t.id}/ai-test`, { message: 'Qual o status do pet 7?', connectionId: acmePet.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.toolCalled, true);
    assert.deepEqual(r.json.args, { petId: 7 });
    assert.equal(r.json.result.status, 200);
    assert.match(r.json.result.text, /"name": "Rex"/);
    assert.match(r.json.result.request.curl, /pet\/7/);
    assert.equal(seen.filter((x) => x.url === '/api/v3/pet/7').at(-1).headers['x-api-key'], 's3cr3t', 'usa a credencial da conexão escolhida');
    assert.equal(r.json.reply, 'Resposta final baseada em: HTTP 200');
    const fn = aiCalls.at(-2).body.tools[0].function;
    assert.equal(fn.name, 'get_pet_by_id');
    assert.ok(fn.parameters.properties.petId);

    const no = await api('POST', `/api/apps/${pet.id}/tools/${t.id}/ai-test`, { message: 'oi, tudo bem?' });
    assert.equal(no.json.toolCalled, false);
    assert.match(no.json.reply, /Preciso do número/);
    assert.equal((await api('POST', `/api/apps/${pet.id}/tools/${t.id}/ai-test`, { message: '' })).status, 400);
  });

  await test('acesso: perfil limitado, preferências e proteção do master', async () => {
    const perms = (await api('GET', '/api/permissions')).json.map((p: any) => p.key);
    assert.ok(perms.includes('clients.edit') && perms.includes('credentials.manage'));
    const prof = await api('POST', '/api/profiles', { name: 'Consulta', permissions: ['apps.view', 'clients.view'] });
    assert.equal(prof.status, 201);
    const u = await api('POST', '/api/users', { username: 'maria', name: 'Maria', profileId: prof.json.id, password: 'segredo1' });
    assert.equal(u.status, 201, JSON.stringify(u.json));
    assert.equal((await api('POST', '/api/users', { username: 'maria', name: 'Outra', profileId: prof.json.id, password: 'segredo1' })).status, 409);

    const m = await login('maria', 'segredo1');
    assert.equal(m.status, 200);
    const as = (method: string, url: string, body?: unknown) => api(method, url, body, m.cookie);
    assert.equal((await as('GET', '/api/apps')).status, 200);
    assert.equal((await as('GET', '/api/clients')).status, 200);
    assert.equal((await as('POST', '/api/clients', { nexusOrgId: 'org-beta' })).status, 403, 'sem clients.edit');
    assert.equal((await as('GET', '/api/users')).status, 403, 'sem access.manage');
    assert.equal((await as('GET', '/api/invocations')).status, 403, 'sem logs.view');
    assert.equal((await as('PATCH', `/api/apps/${pet.id}`, { name: 'x' })).status, 403);
    const c = await as('GET', `/api/connections/${acmePet.id}`);
    assert.equal(c.status, 200);
    assert.equal(c.json.oauth.clientSecret, '', 'secret oculto sem credentials.manage');
    assert.ok(!c.json.oauth.curl.includes(acmePet.oauth.clientSecret));
    assert.equal((await as('POST', `/api/connections/${acmePet.id}/rotate-credentials`)).status, 403);

    // preferência de visualização salva no perfil do usuário
    const pr = await as('PATCH', '/api/me/prefs', { viewMode: { clients: 'list' } });
    assert.deepEqual(pr.json.prefs.viewMode, { apps: 'cards', clients: 'list' });
    assert.equal((await as('GET', '/api/me')).json.prefs.viewMode.clients, 'list');

    // trocar a própria senha
    assert.equal((await as('POST', '/api/me/password', { current: 'errada', password: 'novaSenha1' })).status, 400);
    assert.equal((await as('POST', '/api/me/password', { current: 'segredo1', password: 'novaSenha1' })).status, 200);
    assert.equal((await login('maria', 'novaSenha1')).status, 200);

    // desativar encerra o acesso
    await api('PATCH', `/api/users/${u.json.id}`, { active: false });
    assert.equal((await as('GET', '/api/me')).status, 401);
    assert.equal((await login('maria', 'novaSenha1')).status, 401);

    // perfil em uso não pode ser excluído; master protegido
    assert.equal((await api('DELETE', `/api/profiles/${prof.json.id}`)).status, 409);
    const users = (await api('GET', '/api/users')).json;
    const master = users.find((x: any) => x.master);
    assert.equal((await api('DELETE', `/api/users/${master.id}`)).status, 400);
    assert.equal((await api('PATCH', `/api/users/${master.id}`, { active: false })).status, 400);
    assert.equal((await api('PATCH', `/api/profiles/admin`, { permissions: ['apps.view'] })).status, 400);
    assert.equal((await api('DELETE', `/api/users/${u.json.id}`)).status, 204);
    assert.equal((await api('DELETE', `/api/profiles/${prof.json.id}`)).status, 204);

    // logout encerra a sessão
    const tmp = await login('joelson', 'joel777');
    await api('POST', '/api/auth/logout', undefined, tmp.cookie);
    assert.equal((await api('GET', '/api/me', undefined, tmp.cookie)).status, 401);
  });

  await test('excluir cliente remove os vínculos', async () => {
    assert.equal((await api('DELETE', `/api/clients/${beta.id}`)).status, 204);
    await assert.rejects(mcpClient('beta-provedor-sa/petstore-mock', betaTok));
    assert.equal((await api('GET', `/api/connections/${betaPet.id}`)).status, 404);
  });

  console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}.`);
} finally {
  proc.kill();
  upstream.close();
  rmSync(dataDir, { recursive: true, force: true });
}
