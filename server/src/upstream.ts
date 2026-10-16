import { isCredentialHeader } from './importer.js';
import type { App, Connection, Tool, UpstreamAuth } from './types.js';

/** Para onde e com qual credencial a tool é chamada (resolvido a partir do vínculo Cliente × App). */
export interface UpstreamTarget {
  baseUrl: string;
  auth: UpstreamAuth;
  extraHeaders: Record<string, string>;
}

/** Define um header ignorando maiúsculas/minúsculas: substitui qualquer variação já existente (X-API-Key = x-api-key). */
export function setHeader(h: Record<string, string>, name: string, value: string) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) delete h[k];
  h[name] = value;
}

const hasHeader = (h: Record<string, string>, name: string) => Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());

/**
 * Headers que a conexão controla (credencial + headers extras). Um argumento de tool com o
 * mesmo nome é ignorado: a configuração da conexão sempre vence e o header nunca duplica.
 */
export function managedHeaders(t: UpstreamTarget): Set<string> {
  const s = new Set(Object.keys(t.extraHeaders).map((k) => k.toLowerCase()));
  if (t.auth.type === 'bearer' || t.auth.type === 'basic') s.add('authorization');
  if (t.auth.type === 'apiKey' && t.auth.in !== 'query') s.add(t.auth.headerName.toLowerCase());
  return s;
}

/** Header vindo de argumento que não deve ser aceito (credencial ou já definido pela conexão). */
export const blockedHeaderArg = (t: UpstreamTarget, wire: string) => isCredentialHeader(wire) || managedHeaders(t).has(wire.toLowerCase());

export const targetFor = (app: App, conn?: Connection): UpstreamTarget => ({
  baseUrl: conn?.baseUrl || app.baseUrl,
  auth: conn?.auth ?? { type: 'none' },
  extraHeaders: conn?.extraHeaders ?? {},
});

const MAX_BODY = 100_000;
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Comando curl equivalente (segredos mascarados) */
  curl: string;
}

export interface UpstreamResult {
  ok: boolean;
  status: number | null;
  ms: number;
  url: string;
  text: string;
  error?: string;
  /** Como a requisição foi montada e enviada à API (segredos mascarados) */
  request?: UpstreamRequest;
  /** Headers da resposta da API */
  responseHeaders?: Record<string, string>;
}

/** Mascara um segredo mantendo só o começo (ex.: "abcd••••"). */
export function mask(v: string): string {
  if (!v) return v;
  return v.length < 12 ? '••••' : v.slice(0, 4) + '••••';
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(method: string, url: string, headers: Record<string, string>, body?: string): string {
  const parts = [`curl -X ${method} ${shq(url)}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (body !== undefined) parts.push(`--data-raw ${shq(body)}`);
  return parts.join(' \\\n  ');
}

/** Monta e executa a chamada HTTP da tool contra a API do app. */
export async function callUpstream(app: UpstreamTarget, tool: Tool, args: Record<string, unknown>): Promise<UpstreamResult> {
  const started = Date.now();
  if (!app.baseUrl) return fail('Sem URL base configurada (defina no App ou no vínculo do cliente).', started, '');

  let path = tool.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: 'application/json, */*' };
  const form = new URLSearchParams();
  let body: unknown;

  for (const p of tool.params) {
    const v = args?.[p.name];
    if (v === undefined || v === null || v === '') continue;
    const wire = p.wireName ?? p.name;
    switch (p.in) {
      case 'path':
        path = path.replaceAll(`{${wire}}`, encodeURIComponent(String(v)));
        break;
      case 'query':
        if (Array.isArray(v)) v.forEach((x) => query.append(wire, String(x)));
        else query.append(wire, typeof v === 'object' ? JSON.stringify(v) : String(v));
        break;
      case 'header':
        if (blockedHeaderArg(app, wire)) break; // credencial/header da conexão: nunca vem do modelo
        setHeader(headers, wire, String(v));
        break;
      case 'form':
        if (p.name === 'body' && typeof v === 'object') for (const [k, x] of Object.entries(v as object)) form.append(k, String(x));
        else form.append(wire, String(v));
        break;
      case 'body':
        body = v;
        break;
    }
  }

  const missing = path.match(/\{[^}]+\}/g);
  if (missing) return fail(`Parâmetro(s) de path obrigatório(s) ausente(s): ${missing.join(', ')}`, started, '');

  // Bloqueia path traversal para fora da URL base do app
  const base = new URL(app.baseUrl.endsWith('/') ? app.baseUrl : app.baseUrl + '/');
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    return fail('Chamada fora da URL base do app foi bloqueada.', started, url.toString());

  // configuração da conexão por último: headers extras e credencial substituem o que veio de argumento
  for (const [k, v] of Object.entries(app.extraHeaders)) setHeader(headers, k, v);

  switch (app.auth.type) {
    case 'bearer':
      setHeader(headers, 'authorization', `Bearer ${app.auth.token}`);
      break;
    case 'basic':
      setHeader(headers, 'authorization', 'Basic ' + Buffer.from(`${app.auth.username}:${app.auth.password}`).toString('base64'));
      break;
    case 'apiKey':
      if (app.auth.in === 'query') query.set(app.auth.headerName, app.auth.value);
      else setHeader(headers, app.auth.headerName, app.auth.value);
      break;
  }

  query.forEach((v, k) => url.searchParams.append(k, v));

  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  } else if ([...form.keys()].length) {
    payload = form.toString();
    setHeader(headers, 'content-type', 'application/x-www-form-urlencoded');
  }

  const request = describe(url, headers, payload);
  try {
    const res = await fetch(url, { method: tool.method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (responseHeaders[k] = v));
    let text = await res.text();
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* não-JSON: devolve como veio */
    }
    if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY) + `\n… (resposta truncada em ${MAX_BODY} caracteres)`;
    return { ok: res.ok, status: res.status, ms: Date.now() - started, url: redact(url), text, request, responseHeaders };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? `Timeout após ${TIMEOUT_MS} ms` : String(e?.cause?.message ?? e?.message ?? e);
    return { ...fail(msg, started, redact(url)), request };
  }

  /** Versão da requisição para log/exibição, com credenciais mascaradas. */
  function describe(u: URL, h: Record<string, string>, b?: string): UpstreamRequest {
    const secretHeaders = new Set(['authorization', 'proxy-authorization', 'cookie']);
    if (app.auth.type === 'apiKey' && app.auth.in !== 'query') secretHeaders.add(app.auth.headerName.toLowerCase());
    const hs: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (!secretHeaders.has(k.toLowerCase())) hs[k] = v;
      else {
        const m = v.match(/^(Bearer|Basic)\s+(.*)$/i);
        hs[k] = m ? `${m[1]} ${mask(m[2])}` : mask(v);
      }
    }
    const safeUrl = redact(u);
    return { method: tool.method, url: safeUrl, headers: hs, body: b, curl: toCurl(tool.method, safeUrl, hs, b) };
  }

  function redact(u: URL) {
    const c = new URL(u);
    if (app.auth.type === 'apiKey' && app.auth.in === 'query') c.searchParams.set(app.auth.headerName, mask(app.auth.value));
    return c.toString();
  }
}

function fail(error: string, started: number, url: string): UpstreamResult {
  return { ok: false, status: null, ms: Date.now() - started, url, text: '', error };
}
