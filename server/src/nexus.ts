/**
 * Integração com a API do Nexus (Matrix do Brasil): login e listagem de organizações,
 * usada para escolher o cliente na hora do cadastro.
 *
 * Configuração (server/.env ou variáveis de ambiente):
 *   NEXUS_API_URL   padrão https://api.nexus.matrixdobrasil.ai
 *   NEXUS_EMAIL     e-mail do usuário de integração
 *   NEXUS_PASSWORD  senha do usuário de integração
 *   NEXUS_TOKEN     (opcional) token fixo, usado no lugar do login
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface NexusOrg {
  id: string;
  name: string;
  tradeName?: string;
  document?: string;
  active?: boolean;
}

const BASE = () => (process.env.NEXUS_API_URL ?? 'https://api.nexus.matrixdobrasil.ai').replace(/\/+$/, '');
const TIMEOUT = 20_000;

export const nexusConfigured = () => !!(process.env.NEXUS_TOKEN || (process.env.NEXUS_EMAIL && process.env.NEXUS_PASSWORD));

/**
 * Sessão do Nexus: o token é reaproveitado até expirar (campo "exp" do JWT) e fica salvo em
 * DATA_DIR/nexus-session.json, então reiniciar o servidor não gera um novo login.
 * Um novo login só acontece quando o token expira (ou se o Nexus recusar o token com 401).
 */
const SESSION_FILE = () => path.join(process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'), 'nexus-session.json');
type Session = { token: string; exp: number; email?: string };
let session: Session | null = null;
let sessionLoaded = false;

function loadSession(): Session | null {
  if (sessionLoaded) return session;
  sessionLoaded = true;
  try {
    if (existsSync(SESSION_FILE())) {
      const s = JSON.parse(readFileSync(SESSION_FILE(), 'utf8')) as Session;
      // descarta sessão salva de outro usuário (NEXUS_EMAIL mudou)
      if (s?.token && s.exp && (!s.email || s.email === process.env.NEXUS_EMAIL)) session = s;
    }
  } catch {
    /* arquivo inválido: ignora */
  }
  return session;
}

function saveSession(s: Session | null) {
  session = s;
  try {
    mkdirSync(path.dirname(SESSION_FILE()), { recursive: true });
    writeFileSync(SESSION_FILE(), JSON.stringify(s ?? {}), { mode: 0o600 });
  } catch {
    /* sem disco: segue só em memória */
  }
}

/** Token ainda válido? Margem de 15 s para não enviar um token que expira no meio da chamada. */
const valid = (s: Session | null) => !!s && s.exp - Date.now() > 15_000;

/** Informações da sessão atual (sem o token). */
export function nexusSessionInfo() {
  const s = loadSession();
  return { loggedIn: valid(s), expiresAt: s?.exp ? new Date(s.exp).toISOString() : null };
}
let orgCache: { at: number; orgs: NexusOrg[] } | null = null;

function httpError(message: string, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

/** Lê o "exp" (segundos) de um JWT sem validar a assinatura. */
function jwtExp(token: string): number {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp * 1000 : Date.now() + 30 * 60_000;
  } catch {
    return Date.now() + 30 * 60_000;
  }
}

/** Procura o token em formatos comuns de resposta de login. */
function pickToken(j: any): string | undefined {
  const cands = [j?.accessToken, j?.access_token, j?.token, j?.data?.accessToken, j?.data?.access_token, j?.data?.token, j?.tokens?.accessToken, j?.data?.tokens?.accessToken];
  return cands.find((x) => typeof x === 'string' && x.length > 20);
}

let loggingIn: Promise<string> | null = null;

/** Devolve o token atual; faz login só se não houver token válido (chamadas simultâneas compartilham o mesmo login). */
function login(): Promise<string> {
  if (process.env.NEXUS_TOKEN) return Promise.resolve(process.env.NEXUS_TOKEN);
  const current = loadSession();
  if (valid(current)) return Promise.resolve(current!.token);
  loggingIn ??= doLogin().finally(() => (loggingIn = null));
  return loggingIn;
}

async function doLogin(): Promise<string> {
  if (!nexusConfigured())
    throw httpError('Integração com o Nexus não configurada. Defina NEXUS_EMAIL e NEXUS_PASSWORD no arquivo server/.env.', 503);

  const res = await fetch(`${BASE()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.NEXUS_EMAIL, password: process.env.NEXUS_PASSWORD, includeAccessToken: true }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((e) => {
    throw httpError(`Não foi possível conectar ao Nexus: ${e?.cause?.message ?? e?.message ?? e}`);
  });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* corpo não-JSON */
  }
  if (!res.ok) throw httpError(`Login no Nexus falhou (HTTP ${res.status}): ${j?.message ?? text.slice(0, 200)}`);
  const token = pickToken(j);
  if (!token) throw httpError('Login no Nexus não retornou um access token (verifique includeAccessToken).');
  saveSession({ token, exp: jwtExp(token), email: process.env.NEXUS_EMAIL });
  return token;
}

function pickList(j: any): any[] {
  for (const c of [j, j?.data, j?.items, j?.results, j?.data?.items, j?.data?.data, j?.data?.results, j?.organizations])
    if (Array.isArray(c)) return c;
  return [];
}

const str = (...v: any[]) => v.find((x) => typeof x === 'string' && x.trim())?.trim() as string | undefined;

function normalize(o: any): NexusOrg | null {
  const id = str(o?.id, o?._id, o?.uuid, o?.organizationId) ?? (typeof o?.id === 'number' ? String(o.id) : undefined);
  const name = str(o?.socialName, o?.razaoSocial, o?.name, o?.legalName, o?.tradeName, o?.fantasyName);
  if (!id || !name) return null;
  const trade = str(o?.tradeName, o?.fantasyName, o?.nomeFantasia, o?.displayName);
  const active =
    typeof o?.active === 'boolean' ? o.active : typeof o?.isActive === 'boolean' ? o.isActive : typeof o?.status === 'string' ? !/inativ|inactive|disabled|blocked/i.test(o.status) : undefined;
  return { id, name, tradeName: trade && trade !== name ? trade : undefined, document: str(o?.document, o?.cnpj, o?.cpfCnpj, o?.taxId, o?.documentNumber), active };
}

async function getPage(token: string, page: number, perPage: number) {
  const url = `${BASE()}/api/v1/organizations?page=${page}&perPage=${perPage}&sortBy=socialName&sortOrder=asc`;
  return fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT) }).catch(
    (e) => {
      throw httpError(`Não foi possível conectar ao Nexus: ${e?.cause?.message ?? e?.message ?? e}`);
    },
  );
}

/** Lista todas as organizações do Nexus (com cache de 60 s). */
export async function listOrganizations(force = false): Promise<NexusOrg[]> {
  if (!force && orgCache && Date.now() - orgCache.at < 60_000) return orgCache.orgs;
  const perPage = 500;
  const all: NexusOrg[] = [];
  let token = await login();
  for (let page = 1; page <= 20; page++) {
    let res = await getPage(token, page, perPage);
    if (res.status === 401 && !process.env.NEXUS_TOKEN) {
      saveSession(null); // Nexus recusou o token (revogado/expirado): refaz o login uma vez
      token = await login();
      res = await getPage(token, page, perPage);
    }
    const text = await res.text();
    if (!res.ok) throw httpError(`Nexus respondeu HTTP ${res.status} ao listar organizações: ${text.slice(0, 200)}`);
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw httpError('Resposta do Nexus não é JSON.');
    }
    const list = pickList(j);
    for (const o of list) {
      const n = normalize(o);
      if (n) all.push(n);
    }
    const meta = j?.meta ?? j?.pagination ?? j?.data?.meta ?? j;
    const last = Number(meta?.lastPage ?? meta?.totalPages ?? meta?.pages ?? NaN);
    if (list.length < perPage || (!Number.isNaN(last) && page >= last)) break;
  }
  all.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  orgCache = { at: Date.now(), orgs: all };
  return all;
}
