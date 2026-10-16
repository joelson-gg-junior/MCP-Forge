import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isCredentialHeader } from './importer.js';
import type { AccessToken, App, Client, Connection, Invocation, InvocationSummary, OAuthClient, Profile, Session, User } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'db.json');

interface Db {
  apps: App[];
  clients: Client[];
  connections: Connection[];
  tokens: AccessToken[];
  invocations: Invocation[];
  users: User[];
  profiles: Profile[];
  sessions: Session[];
}

const MAX_LOGS = Number(process.env.MAX_LOGS ?? 1000);

export interface InvocationFilter {
  app?: string;
  client?: string;
  id?: string;
  tool?: string;
  /** Código exato (200), faixa (2xx, 4xx...), "erro" ou "sem resposta" */
  status?: string;
  /** Data/hora ISO (inclusive), com precisão de segundos */
  from?: string;
  to?: string;
  limit?: number;
}

let db: Db = { apps: [], clients: [], connections: [], tokens: [], invocations: [], users: [], profiles: [], sessions: [] };
let writing: Promise<void> = Promise.resolve();

/** Executado depois de carregar o banco (ou com banco novo): garante perfis e o admin master. */
let afterLoad: (() => boolean) | null = null;
export const onDbLoaded = (fn: () => boolean) => (afterLoad = fn);

export function loadDb() {
  loadFile();
  if (afterLoad?.()) void saveDb();
}

function loadFile() {
  if (existsSync(FILE)) {
    db = JSON.parse(readFileSync(FILE, 'utf8')) as Db;
    db.invocations ??= [];
    db.clients ??= [];
    db.connections ??= [];
    db.tokens ??= [];
    db.users ??= [];
    db.profiles ??= [];
    db.sessions ??= [];
    const changed = [migrateLegacyApps(), migrateToLab(), ensureLabAndOAuth(), dropCredentialHeaderParams()].some(Boolean);
    if (changed) void saveDb();
    // Logs antigos (antes do código por requisição) ganham um id estável
    db.invocations.forEach((i, n) => (i.id ??= `RQ-OLD${String(n).padStart(4, '0')}`));
  }
}

/** Cliente virtual usado pelas conexões de laboratório (configuração direta do MCP App). */
export const LAB_CLIENT: Client = { id: 'lab', slug: 'lab', name: 'Laboratório', createdAt: '' };

/** Slugs de cliente reservados (conflitariam com rotas do sistema). */
export const RESERVED_CLIENT_SLUGS = new Set(['lab', 'oauth', 'api', 'mcp']);

export const TOKEN_TTL_SECONDS = Number(process.env.OAUTH_TOKEN_TTL_SECONDS ?? 24 * 60 * 60);

const rand = (n: number) => randomBytes(n).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newOAuthClient(): OAuthClient {
  return { clientId: `mcpc_${rand(12)}`, clientSecret: `mcps_${rand(32)}`, createdAt: new Date().toISOString() };
}

export function newLabConnection(app: App, from?: Partial<Connection>): Connection {
  return {
    id: `lab_${app.id}`,
    clientId: LAB_CLIENT.id,
    appId: app.id,
    lab: true,
    baseUrl: from?.baseUrl ?? app.baseUrl,
    auth: from?.auth ?? { type: 'none' },
    extraHeaders: from?.extraHeaders ?? {},
    oauth: newOAuthClient(),
    requireAccessKey: from?.requireAccessKey ?? true,
    enabled: true,
    legacyAppSlug: from?.legacyAppSlug,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Bancos de antes dos clientes guardavam credencial e chave MCP no próprio App.
 * Esses dados viram a conexão de laboratório do app (configuração direta do MCP).
 */
function migrateLegacyApps(): boolean {
  const legacy = db.apps.filter((a) => a.accessKey !== undefined || a.auth !== undefined);
  for (const a of legacy) {
    if (!db.connections.some((c) => c.appId === a.id && c.lab))
      db.connections.push(
        newLabConnection(a, { auth: a.auth, extraHeaders: a.extraHeaders, requireAccessKey: a.requireAccessKey, legacyAppSlug: a.slug }),
      );
    delete a.auth;
    delete a.extraHeaders;
    delete a.accessKey;
    delete a.requireAccessKey;
  }
  return legacy.length > 0;
}

/** Versão anterior migrava para o cliente "Sem cliente (migrado)": isso agora é o laboratório. */
function migrateToLab(): boolean {
  const mig = db.clients.find((c) => c.id === 'migrado');
  if (!mig) return false;
  for (const c of db.connections.filter((x) => x.clientId === mig.id)) {
    if (db.connections.some((x) => x.appId === c.appId && x.lab)) continue;
    c.clientId = LAB_CLIENT.id;
    c.lab = true;
    c.baseUrl ||= db.apps.find((a) => a.id === c.appId)?.baseUrl ?? '';
  }
  if (!db.connections.some((x) => x.clientId === mig.id)) db.clients = db.clients.filter((c) => c !== mig);
  return true;
}

/**
 * Tools importadas antes da correção podiam ter headers de credencial (ex.: x-api-key da collection
 * Postman) como parâmetro. Remove esses parâmetros: a credencial vem só da conexão.
 */
function dropCredentialHeaderParams(): boolean {
  let changed = false;
  for (const a of db.apps)
    for (const t of a.tools) {
      const drop = t.params.filter((p) => p.in === 'header' && isCredentialHeader(p.wireName ?? p.name)).map((p) => p.name);
      if (!drop.length) continue;
      t.params = t.params.filter((p) => !drop.includes(p.name));
      const sch = t.inputSchema as any;
      for (const d of drop) delete sch.properties?.[d];
      if (Array.isArray(sch.required)) sch.required = sch.required.filter((r: string) => !drop.includes(r));
      changed = true;
    }
  return changed;
}

/** Todo app tem conexão de laboratório e toda conexão tem credenciais OAuth. */
function ensureLabAndOAuth(): boolean {
  let changed = false;
  for (const a of db.apps)
    if (!db.connections.some((c) => c.appId === a.id && c.lab)) {
      db.connections.push(newLabConnection(a));
      changed = true;
    }
  for (const c of db.connections)
    if (!c.oauth) {
      c.oauth = newOAuthClient();
      delete c.accessKey; // chave estática antiga não é mais aceita
      changed = true;
    }
  return changed;
}

/** Grava de forma serializada e atômica (tmp + rename). */
export function saveDb(): Promise<void> {
  writing = writing.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, FILE);
  });
  return writing;
}

export const store = {
  apps: () => db.apps,
  app: (idOrSlug: string) => db.apps.find((a) => a.id === idOrSlug || a.slug === idOrSlug),
  addApp(app: App) {
    db.apps.push(app);
    db.connections.push(newLabConnection(app));
    return saveDb();
  },
  removeApp(id: string) {
    db.apps = db.apps.filter((a) => a.id !== id);
    const gone = new Set(db.connections.filter((c) => c.appId === id).map((c) => c.id));
    db.connections = db.connections.filter((c) => !gone.has(c.id));
    db.tokens = db.tokens.filter((t) => !gone.has(t.connectionId));
    return saveDb();
  },
  clients: () => db.clients,
  client: (idOrSlug: string) => db.clients.find((c) => c.id === idOrSlug || c.slug === idOrSlug),
  addClient(c: Client) {
    db.clients.push(c);
    return saveDb();
  },
  removeClient(id: string) {
    db.clients = db.clients.filter((c) => c.id !== id);
    const gone = new Set(db.connections.filter((c) => c.clientId === id).map((c) => c.id));
    db.connections = db.connections.filter((c) => !gone.has(c.id));
    db.tokens = db.tokens.filter((t) => !gone.has(t.connectionId));
    return saveDb();
  },
  /** Conexões de clientes (sem as de laboratório, salvo includeLab). */
  connections: (f: { clientId?: string; appId?: string; includeLab?: boolean } = {}) =>
    db.connections.filter(
      (c) => (f.includeLab || !c.lab) && (!f.clientId || c.clientId === f.clientId) && (!f.appId || c.appId === f.appId),
    ),
  connection: (id: string) => db.connections.find((c) => c.id === id),
  labConnection: (appId: string) => db.connections.find((c) => c.appId === appId && c.lab),
  findConnection: (clientId: string, appId: string) => db.connections.find((c) => c.clientId === clientId && c.appId === appId),
  connectionByClientId: (oauthClientId: string) => db.connections.find((c) => c.oauth?.clientId === oauthClientId),
  addConnection(c: Connection) {
    db.connections.push(c);
    return saveDb();
  },
  removeConnection(id: string) {
    db.connections = db.connections.filter((c) => c.id !== id);
    db.tokens = db.tokens.filter((t) => t.connectionId !== id);
    return saveDb();
  },

  /* ---------------------- OAuth 2.0 (client_credentials) ---------------------- */

  /** Emite um Bearer token opaco para a conexão; guarda só o hash. */
  issueToken(connectionId: string) {
    const now = Date.now();
    db.tokens = db.tokens.filter((t) => Date.parse(t.expiresAt) > now); // limpa expirados
    const token = `mcpt_${rand(32)}`;
    const expiresAt = new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString();
    db.tokens.push({ hash: sha256(token), connectionId, createdAt: new Date(now).toISOString(), expiresAt });
    void saveDb();
    return { token, expiresAt, expiresIn: TOKEN_TTL_SECONDS };
  },
  /** Conexão dona do token, se ele existir e não tiver expirado. */
  tokenConnection(token: string): string | undefined {
    const h = sha256(token);
    const t = db.tokens.find((x) => x.hash === h);
    return t && Date.parse(t.expiresAt) > Date.now() ? t.connectionId : undefined;
  },
  activeTokens: (connectionId: string) =>
    db.tokens.filter((t) => t.connectionId === connectionId && Date.parse(t.expiresAt) > Date.now()),
  revokeTokens(connectionId: string) {
    const before = db.tokens.length;
    db.tokens = db.tokens.filter((t) => t.connectionId !== connectionId);
    void saveDb();
    return before - db.tokens.length;
  },
  logInvocation(inv: Invocation) {
    db.invocations.unshift(inv);
    db.invocations.length = Math.min(db.invocations.length, MAX_LOGS);
    void saveDb();
  },
  invocation: (id: string) => db.invocations.find((i) => i.id === id),
  invocations(f: InvocationFilter = {}): InvocationSummary[] {
    const from = f.from ? Date.parse(f.from) : NaN;
    const to = f.to ? Date.parse(f.to) : NaN;
    const id = f.id?.trim().toUpperCase();
    const tool = f.tool?.trim().toLowerCase();
    const st = f.status?.trim().toLowerCase();
    const out: InvocationSummary[] = [];
    for (const i of db.invocations) {
      if (f.app && i.appSlug !== f.app && i.appId !== f.app) continue;
      if (f.client && i.clientSlug !== f.client && i.clientId !== f.client) continue;
      if (id && !i.id?.toUpperCase().includes(id)) continue;
      if (tool && !i.tool.toLowerCase().includes(tool)) continue;
      if (st) {
        if (st === 'erro' || st === 'error') {
          if (i.ok) continue;
        } else if (st === 'sem resposta' || st === 'null') {
          if (i.status !== null) continue;
        } else if (/^[1-5]xx$/.test(st)) {
          if (i.status === null || String(i.status)[0] !== st[0]) continue;
        } else if (String(i.status) !== st) continue;
      }
      const t = Date.parse(i.at);
      if (!Number.isNaN(from) && t < from) continue;
      if (!Number.isNaN(to) && t > to) continue;
      const { mcp, upstream, ...rest } = i;
      out.push({ ...rest, method: upstream?.method, url: upstream?.url });
      if (out.length >= (f.limit ?? 200)) break;
    }
    return out;
  },
  /* ------------------------------ acesso ------------------------------ */
  users: () => db.users,
  profiles: () => db.profiles,
  sessions: () => db.sessions,
  setUsers: (u: User[]) => (db.users = u),
  setProfiles: (p: Profile[]) => (db.profiles = p),
  setSessions: (s: Session[]) => (db.sessions = s),

  save: saveDb,
};
