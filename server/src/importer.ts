import YAML from 'yaml';
import { nanoid } from 'nanoid';
import type { App, Tool, ToolParam } from './types.js';

type Json = Record<string, any>;

export interface ImportResult {
  kind: App['source']['kind'];
  title?: string;
  version?: string;
  baseUrl: string;
  tools: Tool[];
  warnings: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Headers que carregam credencial (API key, token, cookie...). Eles vêm da configuração
 * da conexão (laboratório ou cliente), nunca de argumento da tool — senão o modelo envia
 * o valor de exemplo da documentação e a API recebe o header duplicado.
 */
export function isCredentialHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|cookie|x-?api-?key|api-?key|apikey|x-?auth-?token|x-?access-?token|access-?token|x-?token|x-?client-?secret|client-?secret|x-?subscription-?key|ocp-apim-subscription-key)$/i.test(
    name.trim(),
  );
}

const credentialWarning = (h: string) =>
  `Header "${h}" é credencial: configure em Dados da API (laboratório ou cliente); ele não vira parâmetro das tools.`;
const MAX_DESC = 1024;

/* ----------------------------- carregamento ----------------------------- */

/** Converte links de páginas conhecidas para o JSON bruto da collection/spec. */
export function normalizeSourceUrl(url: string): string {
  // Postman Documenter: https://documenter.getpostman.com/view/<owner>/<collection>
  const m = url.match(/documenter\.getpostman\.com\/view\/(\d+)\/([A-Za-z0-9_-]+)/);
  if (m) return `https://documenter.gw.postman.com/api/collections/${m[1]}/${m[2]}?segregateAuth=true&versionTag=latest`;
  return url;
}

async function rawFetch(url: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url, {
    headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Falha ao baixar a documentação (${res.status} ${res.statusText})`);
  return { text: await res.text(), url: res.url || url };
}

const isHtml = (t: string) => t.trimStart().startsWith('<');

/** Tenta interpretar o texto como spec (JSON/YAML) sem lançar erro. */
function looksLikeSpec(text: string): boolean {
  if (isHtml(text)) return false;
  try {
    const d = parseSpecText(text);
    return !!(d.openapi || d.swagger || (d.info && Array.isArray(d.item)) || d.collection?.item);
  } catch {
    return false;
  }
}

/** Extrai o objeto JSON que começa em `start` (contagem de chaves, respeitando strings). */
function extractJsonObject(src: string, start: number): string | undefined {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return undefined;
}

/** Spec embutida (swagger-ui-express: `"swaggerDoc": {...}`, ou `spec: {...}` no SwaggerUIBundle). */
function embeddedSpec(js: string): string | undefined {
  for (const re of [/["']?swaggerDoc["']?\s*:\s*\{/, /\bspec\s*:\s*\{/]) {
    const m = re.exec(js);
    if (!m) continue;
    const obj = extractJsonObject(js, m.index + m[0].length - 1);
    if (obj && looksLikeSpec(obj)) return obj;
  }
  return undefined;
}

/** URLs de spec referenciadas na página (Swagger UI, Redoc, Scalar, RapiDoc). */
function specUrlsIn(src: string): string[] {
  const out: string[] = [];
  const res = [
    /\burl\s*:\s*["'`]([^"'`]+)["'`]/g, // SwaggerUIBundle({ url: '...' }) e urls: [{ url: '...' }]
    /spec-url\s*=\s*["']([^"']+)["']/g, // <redoc spec-url="...">, <rapi-doc spec-url="...">
    /data-url\s*=\s*["']([^"']+)["']/g, // Scalar
    /Redoc\.init\(\s*["']([^"']+)["']/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[1]);
  return out.filter((u) => !/^(data:|javascript:)/.test(u) && !/\.(css|png|svg|ico|js)(\?|$)/.test(u));
}

/**
 * Baixa a documentação. Se o link for uma página HTML (Swagger UI, Redoc, etc.),
 * tenta descobrir a spec: embutida no swagger-ui-init.js, referenciada na página
 * ou em caminhos comuns (swagger.json, openapi.json, v3/api-docs...).
 */
export async function fetchSpecText(url: string): Promise<string> {
  const first = await rawFetch(normalizeSourceUrl(url));
  if (!isHtml(first.text)) return first.text;

  const base = first.url.endsWith('/') ? first.url : first.url.replace(/[^/]*$/, '') || first.url;
  const abs = (u: string) => new URL(u, base).toString();
  const tried = new Set<string>([first.url]);
  const tryUrl = async (u: string): Promise<string | undefined> => {
    const full = abs(u);
    if (tried.has(full)) return undefined;
    tried.add(full);
    try {
      const r = await rawFetch(full);
      if (looksLikeSpec(r.text)) return r.text;
      const emb = embeddedSpec(r.text);
      if (emb) return emb;
    } catch {
      /* ignora e segue para o próximo candidato */
    }
    return undefined;
  };

  // 1) spec embutida no próprio HTML
  const inline = embeddedSpec(first.text);
  if (inline) return inline;

  // 2) scripts locais (ex.: swagger-ui-init.js do swagger-ui-express)
  const scripts = [...first.text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((s) => /init|config|swagger|openapi|docs/i.test(s) && !/bundle|standalone|polyfill|redoc\.standalone/i.test(s));
  if (/swagger-ui/i.test(first.text) && !scripts.some((s) => /swagger-ui-init/.test(s))) scripts.push('swagger-ui-init.js');
  for (const s of scripts) {
    const full = abs(s);
    if (tried.has(full)) continue;
    tried.add(full);
    try {
      const js = (await rawFetch(full)).text;
      const emb = embeddedSpec(js);
      if (emb) return emb;
      for (const u of specUrlsIn(js)) {
        const r = await tryUrl(u);
        if (r) return r;
      }
    } catch {
      /* segue */
    }
  }

  // 3) URLs referenciadas no HTML
  for (const u of specUrlsIn(first.text)) {
    const r = await tryUrl(u);
    if (r) return r;
  }

  // 4) caminhos comuns
  const origin = new URL(first.url).origin;
  const guesses = [
    'swagger.json', 'openapi.json', 'swagger.yaml', 'openapi.yaml', 'api-docs.json', 'v3/api-docs', 'swagger/v1/swagger.json',
  ];
  for (const g of guesses) {
    const r = (await tryUrl(abs(g))) ?? (await tryUrl(`${origin}/${g}`));
    if (r) return r;
  }

  return first.text; // parseSpecText devolve a mensagem de erro de HTML
}

export function parseSpecText(text: string): Json {
  const t = text.trim();
  if (t.startsWith('<')) {
    throw new Error(
      'O link retornou HTML e não encontrei a spec na página. Use o link direto do arquivo OpenAPI/Swagger (JSON/YAML), cole o conteúdo na aba "Colar / arquivo" ou exporte a collection do Postman (v2.1).',
    );
  }
  try {
    return JSON.parse(t);
  } catch {
    const doc = YAML.parse(t);
    if (!doc || typeof doc !== 'object') throw new Error('Conteúdo não é JSON nem YAML válido.');
    return doc;
  }
}

export function importSpec(spec: Json, sourceUrl?: string): ImportResult {
  if (typeof spec.openapi === 'string' && spec.openapi.startsWith('3')) return importOpenApi(spec, 'openapi3', sourceUrl);
  if (spec.swagger === '2.0') return importOpenApi(spec, 'swagger2', sourceUrl);
  if (spec.info && Array.isArray(spec.item)) return importPostman(spec);
  // Alguns exports do Postman vêm embrulhados em { collection: {...} }
  if (spec.collection?.item) return importPostman(spec.collection);
  throw new Error('Formato não reconhecido. Suportados: OpenAPI 3.x, Swagger 2.0 e Postman Collection v2.x.');
}

/* ------------------------------- helpers -------------------------------- */

export function toolName(raw: string): string {
  const s = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return (s || 'tool').slice(0, 64);
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base.slice(0, 60)}_${i++}`;
  used.add(name);
  return name;
}

function clip(s: string, n = MAX_DESC) {
  s = s.replace(/\r/g, '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
}

/** Resolve $ref locais (#/...) com proteção contra ciclos e profundidade. */
function makeResolver(root: Json) {
  const get = (ref: string) =>
    ref
      .replace(/^#\//, '')
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<any>((o, k) => (o == null ? undefined : o[k]), root);

  const resolve = (node: any, seen: string[] = [], depth = 0): any => {
    if (node == null || typeof node !== 'object') return node;
    if (depth > 12) return { type: 'object', description: '(schema truncado: profundidade máxima)' };
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen, depth + 1));
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!ref.startsWith('#/')) return { description: `Referência externa não resolvida: ${ref}` };
      if (seen.includes(ref)) return { type: 'object', description: `(referência circular: ${ref.split('/').pop()})` };
      const { $ref, ...rest } = node;
      return { ...resolve(get(ref), [...seen, ref], depth + 1), ...resolve(rest, seen, depth + 1) };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolve(v, seen, depth + 1);
    return out;
  };
  return resolve;
}

/** Remove palavras-chave que clientes MCP costumam rejeitar e converte nullable/OpenAPI → JSON Schema. */
function cleanSchema(s: any): any {
  if (s == null || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(cleanSchema);
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (['xml', 'example', 'examples', 'externalDocs', 'discriminator', 'readOnly', 'writeOnly', 'deprecated'].includes(k)) continue;
    if (k.startsWith('x-')) continue;
    if (k === 'nullable') continue;
    out[k] = cleanSchema(v);
  }
  if (s.nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (s.example !== undefined && out.description === undefined) out.description = `Exemplo: ${JSON.stringify(s.example).slice(0, 200)}`;
  return out;
}

/* ------------------------------- OpenAPI -------------------------------- */

function importOpenApi(spec: Json, kind: 'openapi3' | 'swagger2', sourceUrl?: string): ImportResult {
  const resolve = makeResolver(spec);
  const warnings: string[] = [];
  const used = new Set<string>();
  const tools: Tool[] = [];

  let baseUrl = '';
  if (kind === 'openapi3') {
    const server = spec.servers?.[0];
    if (server?.url) {
      let u: string = server.url;
      for (const [k, v] of Object.entries<any>(server.variables ?? {})) u = u.replace(`{${k}}`, v.default ?? '');
      try {
        baseUrl = new URL(u, sourceUrl).toString();
      } catch {
        baseUrl = u;
      }
    }
  } else if (spec.host) {
    const scheme = spec.schemes?.includes('https') ? 'https' : spec.schemes?.[0] ?? 'https';
    baseUrl = `${scheme}://${spec.host}${spec.basePath ?? ''}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (!baseUrl) warnings.push('A documentação não declara a URL base da API. Informe-a nas configurações do app.');

  for (const [p, pathItemRaw] of Object.entries<any>(spec.paths ?? {})) {
    const pathItem = resolve(pathItemRaw);
    for (const method of METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;

      const properties: Json = {};
      const required: string[] = [];
      const params: ToolParam[] = [];
      const propNames = new Set<string>();
      const addProp = (wire: string, loc: ToolParam['in'], schema: Json, isReq: boolean) => {
        let prop = wire.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'param';
        if (propNames.has(prop)) prop = `${loc}_${prop}`.slice(0, 64);
        propNames.add(prop);
        properties[prop] = schema;
        if (isReq) required.push(prop);
        params.push({ name: prop, in: loc, wireName: wire });
      };

      const allParams = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
      // parâmetros da operação sobrescrevem os do path (mesmo name+in)
      const merged = new Map<string, any>();
      for (const prm of allParams) merged.set(`${prm.in}:${prm.name}`, prm);

      for (const prm of merged.values()) {
        if (prm.in === 'cookie') continue;
        if (prm.in === 'header' && isCredentialHeader(String(prm.name ?? ''))) {
          const w = credentialWarning(prm.name);
          if (!warnings.includes(w)) warnings.push(w);
          continue;
        }
        if (kind === 'swagger2' && prm.in === 'body') {
          const schema = cleanSchema(prm.schema ?? { type: 'object' });
          if (prm.description && !schema.description) schema.description = clip(prm.description, 400);
          addProp('body', 'body', schema, !!prm.required);
          continue;
        }
        if (kind === 'swagger2' && prm.in === 'formData') {
          const { name, in: _in, required: r, description, ...rest } = prm;
          addProp(name, 'form', cleanSchema({ ...rest, ...(description ? { description: clip(description, 400) } : {}) }), !!r);
          continue;
        }
        const schema = cleanSchema(prm.schema ?? (prm.type ? { type: prm.type, items: prm.items, enum: prm.enum } : { type: 'string' }));
        if (prm.description) schema.description = clip(stripHtml(prm.description), 400);
        addProp(prm.name, prm.in, schema, prm.in === 'path' || !!prm.required);
      }

      if (kind === 'openapi3' && op.requestBody) {
        const content = op.requestBody.content ?? {};
        const jsonKey = Object.keys(content).find((c) => c.includes('json'));
        const formKey = Object.keys(content).find((c) => c.includes('x-www-form-urlencoded'));
        const key = jsonKey ?? formKey ?? Object.keys(content)[0];
        if (key) {
          const schema = cleanSchema(content[key]?.schema ?? { type: 'object' });
          if (op.requestBody.description && !schema.description) schema.description = clip(op.requestBody.description, 400);
          addProp('body', key === formKey ? 'form' : 'body', schema, !!op.requestBody.required);
        }
      }

      const base = toolName(op.operationId ?? `${method}_${p.replace(/[{}]/g, '')}`);
      const name = uniqueName(base, used);
      const desc = [op.summary, op.description && op.description !== op.summary ? stripHtml(op.description) : '']
        .filter(Boolean)
        .join('\n\n');
      const okResp = Object.entries<any>(op.responses ?? {}).find(([code]) => code.startsWith('2'));
      const respNote = okResp?.[1]?.description ? `\n\nResposta ${okResp[0]}: ${stripHtml(okResp[1].description)}` : '';

      tools.push({
        id: nanoid(10),
        name,
        description: clip(`${desc || `${method.toUpperCase()} ${p}`}${respNote}`),
        method: method.toUpperCase(),
        path: p,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        params,
        status: 'draft',
        readOnly: method === 'get' || method === 'head',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (!tools.length) warnings.push('Nenhum endpoint encontrado em "paths".');
  return { kind, title: spec.info?.title, version: spec.info?.version, baseUrl, tools, warnings };
}

/* ------------------------------- Postman -------------------------------- */

function importPostman(col: Json): ImportResult {
  const warnings: string[] = [];
  const used = new Set<string>();
  const tools: Tool[] = [];
  const vars: Record<string, string> = {};
  for (const v of col.variable ?? []) if (v?.key) vars[v.key] = String(v.value ?? '');

  const sub = (s: string) => s.replace(/\{\{([^}]+)\}\}/g, (_, k) => (k in vars && vars[k] ? vars[k] : `{{${k}}}`));
  const hosts = new Map<string, number>();

  const walk = (items: any[], folder: string[]) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) {
        walk(it.item, [...folder, it.name]);
        continue;
      }
      const req = it.request;
      if (!req) continue;
      const method = String(req.method ?? 'GET').toUpperCase();
      const url = typeof req.url === 'string' ? parseRawUrl(req.url) : req.url ?? {};

      // host
      const hostStr = Array.isArray(url.host) ? url.host.join('.') : url.host ?? '';
      const proto = url.protocol ? `${url.protocol}://` : '';
      const host = sub(`${proto}${hostStr}${url.port ? ':' + url.port : ''}`);
      if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);

      const properties: Json = {};
      const required: string[] = [];
      const params: ToolParam[] = [];
      const add = (wire: string, loc: ToolParam['in'], schema: Json, isReq: boolean) => {
        let prop = wire.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'param';
        if (properties[prop]) prop = `${loc}_${prop}`.slice(0, 64);
        properties[prop] = schema;
        if (isReq) required.push(prop);
        params.push({ name: prop, in: loc, wireName: wire });
      };

      // path: ":id" e "{{id}}" viram {id}
      const segs: string[] = (Array.isArray(url.path) ? url.path : String(url.path ?? '').split('/')).filter(
        (s: any) => s !== '' && s != null,
      );
      const pathParts = segs.map((s0: any) => {
        const s = typeof s0 === 'string' ? s0 : s0.value ?? '';
        const m = s.match(/^:(.+)$/) ?? s.match(/^\{\{(.+)\}\}$/);
        if (m) {
          const pv = (url.variable ?? []).find((v: any) => v.key === m[1]);
          if (!properties[m[1]])
            add(m[1], 'path', { type: 'string', ...(pv?.description ? { description: descText(pv.description) } : {}) }, true);
          return `{${m[1]}}`;
        }
        return s;
      });
      const path = '/' + pathParts.join('/');

      for (const q of url.query ?? []) {
        if (!q?.key || q.disabled) continue;
        const d = [descText(q.description), q.value ? `Exemplo: ${q.value}` : ''].filter(Boolean).join(' — ');
        add(q.key, 'query', { type: 'string', ...(d ? { description: d } : {}) }, false);
      }

      for (const h of req.header ?? []) {
        if (!h?.key || h.disabled) continue;
        const k = h.key.toLowerCase();
        if (['content-type', 'accept', 'user-agent'].includes(k)) continue;
        if (isCredentialHeader(k)) {
          const w = credentialWarning(h.key);
          if (!warnings.includes(w)) warnings.push(w);
          continue;
        }
        // headers com valor fixo de variável de ambiente ({{token}}) são configuração, não argumento
        if (/^\{\{.+\}\}$/.test(String(h.value ?? ''))) continue;
        add(h.key, 'header', { type: 'string', ...(h.description ? { description: descText(h.description) } : {}) }, false);
      }

      const body = req.body;
      if (body?.mode === 'raw' && body.raw?.trim()) {
        let ex: any;
        try {
          ex = JSON.parse(body.raw.replace(/\{\{[^}]+\}\}/g, '""'));
        } catch {
          /* não-JSON */
        }
        add(
          'body',
          'body',
          ex && typeof ex === 'object'
            ? { ...inferSchema(ex), description: `Corpo JSON. Exemplo: ${clip(body.raw, 600)}` }
            : { type: 'string', description: `Corpo bruto. Exemplo: ${clip(body.raw, 600)}` },
          true,
        );
      } else if (body?.mode === 'urlencoded' || body?.mode === 'formdata') {
        for (const f of body[body.mode] ?? []) {
          if (!f?.key || f.disabled || f.type === 'file') continue;
          add(f.key, 'form', { type: 'string', ...(f.description ? { description: descText(f.description) } : {}) }, false);
        }
      }

      const base = toolName([...folder.slice(-1), it.name].join(' ') || `${method} ${path}`);
      tools.push({
        id: nanoid(10),
        name: uniqueName(base, used),
        description: clip([it.name, descText(req.description)].filter(Boolean).join('\n\n') || `${method} ${path}`),
        method,
        path,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        params,
        status: 'draft',
        readOnly: method === 'GET' || method === 'HEAD',
        updatedAt: new Date().toISOString(),
      });
    }
  };
  walk(col.item, []);

  const baseUrl = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/\/+$/, '') ?? '';
  if (!baseUrl || baseUrl.includes('{{'))
    warnings.push(`URL base não resolvida (${baseUrl || 'vazia'}). Informe-a nas configurações do app.`);
  if (!tools.length) warnings.push('Nenhuma requisição encontrada na collection.');
  return {
    kind: 'postman',
    title: col.info?.name,
    version: col.info?.version,
    baseUrl: baseUrl.includes('{{') ? '' : baseUrl,
    tools,
    warnings,
  };
}

function descText(d: any): string {
  if (!d) return '';
  const s = typeof d === 'string' ? d : d.content ?? '';
  return clip(stripHtml(s), 600);
}

function parseRawUrl(raw: string): Json {
  const [noHash] = raw.split('#');
  const [base, qs] = noHash.split('?');
  const m = base.match(/^(?:(https?):\/\/)?([^/]*)(\/.*)?$/);
  const query = (qs ?? '')
    .split('&')
    .filter(Boolean)
    .map((kv) => {
      const [key, value] = kv.split('=');
      return { key: decodeURIComponent(key), value: value ? decodeURIComponent(value) : '' };
    });
  return { protocol: m?.[1], host: m?.[2] ?? '', path: (m?.[3] ?? '').split('/').filter(Boolean), query };
}

function inferSchema(v: any, depth = 0): Json {
  if (depth > 6) return {};
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferSchema(v[0], depth + 1) : {} };
  if (v === null) return {};
  if (typeof v === 'object') {
    const properties: Json = {};
    for (const [k, x] of Object.entries(v)) properties[k] = inferSchema(x, depth + 1);
    return { type: 'object', properties };
  }
  return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
}

/* ------------------------------ qualidade ------------------------------- */

export interface Lint {
  score: number;
  issues: string[];
}

/** Heurística simples de qualidade da tool (0–100), para orientar a revisão humana. */
export function lintTool(t: Tool): Lint {
  const issues: string[] = [];
  let score = 100;
  const plain = t.description.replace(/\s+/g, ' ').trim();
  if (plain.length < 40) {
    score -= 30;
    issues.push('Descrição curta: explique o que a tool faz e quando usá-la.');
  }
  if (plain === `${t.method} ${t.path}`) {
    score -= 20;
    issues.push('Descrição é só método + path.');
  }
  const props = Object.entries<any>((t.inputSchema as any).properties ?? {});
  const undocumented = props.filter(([, s]) => !s?.description).map(([k]) => k);
  if (undocumented.length) {
    score -= Math.min(30, undocumented.length * 8);
    issues.push(`Parâmetros sem descrição: ${undocumented.slice(0, 6).join(', ')}${undocumented.length > 6 ? '…' : ''}`);
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) {
    score -= 20;
    issues.push('Nome inválido para MCP (use a-z, 0-9, _ e -; até 64).');
  }
  if (!t.readOnly && !/\b(cria|altera|remove|exclui|atualiza|create|update|delete|remove)/i.test(plain)) {
    score -= 10;
    issues.push('Tool com escrita: deixe claro na descrição que ela altera dados.');
  }
  return { score: Math.max(0, score), issues };
}
