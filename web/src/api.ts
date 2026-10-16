export type ToolStatus = 'draft' | 'approved' | 'disabled'

export interface Tool {
  id: string
  name: string
  description: string
  method: string
  path: string
  inputSchema: { type: 'object'; properties?: Record<string, any>; required?: string[] }
  params: { name: string; in: string; wireName?: string }[]
  status: ToolStatus
  readOnly: boolean
  updatedAt: string
  lint: { score: number; issues: string[] }
}

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; headerName: string; value: string; in?: 'header' | 'query' }

export interface AppSummary {
  id: string
  slug: string
  name: string
  /** URL base padrão (cada cliente pode sobrescrever) */
  baseUrl: string
  source: { kind: string; url?: string; title?: string; version?: string }
  createdAt: string
  counts: { total: number; approved: number; draft: number; disabled: number }
  clientCount: number
  /** Conexão de laboratório (configuração direta do MCP App, para testes) */
  labConnectionId: string
}

export interface AppFull extends AppSummary {
  tools: Tool[]
  connections: ConnSummary[]
}

/** Resumo de um vínculo Cliente × MCP App */
export interface ConnSummary {
  id: string
  enabled: boolean
  app: { id: string; slug: string; name: string }
  client: { id: string; slug: string; name: string }
  baseUrl: string
  authType: Auth['type']
  approvedTools: number
  mcpUrl: string
}

export interface Connection {
  id: string
  /** Conexão de laboratório do app (não é de cliente) */
  lab: boolean
  enabled: boolean
  app: { id: string; slug: string; name: string; baseUrl: string; approvedTools: number }
  client: { id: string; slug: string; name: string }
  /** URL base deste cliente ('' = usa a padrão do app) */
  baseUrl: string
  effectiveBaseUrl: string
  auth: Auth
  extraHeaders: Record<string, string>
  /** Exigir Bearer token (OAuth 2.0) no endpoint MCP */
  requireAccessKey: boolean
  mcpUrl: string
  legacyUrl?: string
  oauth: {
    clientId: string
    clientSecret: string
    createdAt: string
    tokenUrl: string
    tokenTtlSeconds: number
    activeTokens: number
    /** o usuário pode ver o secret e gerar tokens/credenciais (permissão credentials.manage) */
    canManage: boolean
    /** curl pronto para gerar o token */
    curl: string
  }
  createdAt: string
}

export interface OAuthToken {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  expires_at: string
}

export interface Client {
  id: string
  slug: string
  name: string
  tradeName?: string
  document?: string
  nexusOrgId?: string
  createdAt: string
  connections: ConnSummary[]
}

export interface NexusOrg {
  id: string
  name: string
  tradeName?: string
  document?: string
  active?: boolean
  /** cliente já cadastrado para esta organização */
  clientId?: string
}

export interface ClientConfig {
  url: string
  tokenUrl: string
  headers: Record<string, string>
  mcpServers: Record<string, unknown>
}

export interface Invocation {
  /** Código da requisição (ex.: RQ-7K3P9XQ2) */
  id: string
  at: string
  appId?: string
  appSlug: string
  tool: string
  toolId?: string
  status: number | null
  ok: boolean
  ms: number
  error?: string
  method?: string
  url?: string
  clientId?: string
  clientSlug?: string
  clientName?: string
}

export interface InvocationDetail extends Invocation {
  mcp?: {
    request: { http?: { method: string; url: string; headers: Record<string, string> }; body?: unknown } | unknown
    response: unknown
  }
  upstream?: {
    method: string
    url: string
    headers: Record<string, string>
    body?: string
    curl: string
    response?: { status: number | null; headers?: Record<string, string>; body: string }
  }
}

export interface InvocationFilter {
  app?: string
  client?: string
  id?: string
  tool?: string
  status?: string
  from?: string
  to?: string
}

export interface UpstreamResult {
  ok: boolean
  status: number | null
  ms: number
  url: string
  text: string
  error?: string
  /** requisição enviada à API (credenciais mascaradas) */
  request?: { method: string; url: string; headers: Record<string, string>; body?: string; curl: string }
}

export interface AiToolTest {
  model: string
  toolCalled: boolean
  args?: Record<string, unknown>
  result?: UpstreamResult
  reply: string
}

/** Disparado quando a sessão expira (HTTP 401): a tela volta para o login. */
export const UNAUTHORIZED_EVENT = 'mcpf:unauthorized'

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (r.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!r.ok) {
    const detail = data?.details?.[0]?.message
    throw new Error(data?.error === 'Dados inválidos' && detail ? detail : (data?.error ?? `Erro ${r.status}`))
  }
  return data as T
}

/* ------------------------------- acesso ------------------------------- */

export type ViewMode = 'cards' | 'list'

export interface UserRow {
  id: string
  username: string
  name: string
  email?: string
  profileId: string
  profileName: string
  active: boolean
  master: boolean
  createdAt: string
  lastLoginAt?: string
}

export interface Me extends UserRow {
  permissions: string[]
  prefs: { viewMode: { apps: ViewMode; clients: ViewMode } }
}

export interface ProfileRow {
  id: string
  name: string
  description?: string
  permissions: string[]
  system?: boolean
  userCount: number
  createdAt: string
}

export interface PermissionDef {
  key: string
  label: string
  group: string
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  login: (username: string, password: string) => req<Me>('POST', '/api/auth/login', { username, password }),
  logout: () => req<{ ok: true }>('POST', '/api/auth/logout'),
  savePrefs: (viewMode: Partial<Me['prefs']['viewMode']>) => req<Me>('PATCH', '/api/me/prefs', { viewMode }),
  changePassword: (current: string, password: string) => req<{ ok: true }>('POST', '/api/me/password', { current, password }),
  permissions: () => req<PermissionDef[]>('GET', '/api/permissions'),
  profiles: () => req<ProfileRow[]>('GET', '/api/profiles'),
  createProfile: (b: { name: string; description?: string; permissions: string[] }) => req<ProfileRow>('POST', '/api/profiles', b),
  updateProfile: (id: string, b: { name?: string; description?: string; permissions?: string[] }) => req<ProfileRow>('PATCH', `/api/profiles/${id}`, b),
  deleteProfile: (id: string) => req<null>('DELETE', `/api/profiles/${id}`),
  users: () => req<UserRow[]>('GET', '/api/users'),
  createUser: (b: { username: string; name: string; email?: string; profileId: string; password: string }) => req<UserRow>('POST', '/api/users', b),
  updateUser: (id: string, b: { name?: string; email?: string; profileId?: string; active?: boolean; password?: string }) =>
    req<UserRow>('PATCH', `/api/users/${id}`, b),
  deleteUser: (id: string) => req<null>('DELETE', `/api/users/${id}`),

  apps: () => req<AppSummary[]>('GET', '/api/apps'),
  app: (id: string) => req<AppFull>('GET', `/api/apps/${id}`),
  importApp: (b: { name?: string; url?: string; content?: string; baseUrl?: string }) =>
    req<{ app: AppFull; warnings: string[] }>('POST', '/api/apps/import', b),
  reimport: (id: string, b: { url?: string; content?: string }) =>
    req<{ app: AppFull; added: string[]; changed: string[]; removed: string[]; warnings: string[] }>(
      'POST',
      `/api/apps/${id}/reimport`,
      b,
    ),
  updateApp: (id: string, b: Partial<Pick<AppSummary, 'name' | 'baseUrl'>>) => req<AppFull>('PATCH', `/api/apps/${id}`, b),
  deleteApp: (id: string) => req<null>('DELETE', `/api/apps/${id}`),
  updateTool: (
    id: string,
    toolId: string,
    b: { name?: string; description?: string; status?: ToolStatus; paramDescriptions?: Record<string, string> },
  ) => req<Tool>('PATCH', `/api/apps/${id}/tools/${toolId}`, b),
  bulk: (id: string, ids: string[], status: ToolStatus) =>
    req<{ updated: number }>('POST', `/api/apps/${id}/tools/bulk`, { ids, status }),
  testTool: (id: string, toolId: string, args: Record<string, unknown>, connectionId?: string) =>
    req<UpstreamResult>('POST', `/api/apps/${id}/tools/${toolId}/test`, { args, connectionId }),

  aiStatus: () => req<{ configured: boolean; model: string }>('GET', '/api/ai/status'),
  /** Sugestão da IA para descrição da tool e dos parâmetros (não salva). */
  aiDescribe: (id: string, toolId: string) =>
    req<{ description: string; params: Record<string, string>; model: string }>('POST', `/api/apps/${id}/tools/${toolId}/ai-describe`),

  /** A IA lê a mensagem, monta os argumentos e chama a tool de verdade; depois responde com o retorno. */
  aiTest: (id: string, toolId: string, message: string, connectionId?: string) =>
    req<AiToolTest>('POST', `/api/apps/${id}/tools/${toolId}/ai-test`, { message, connectionId }),

  nexusStatus: () => req<{ configured: boolean; loggedIn: boolean; expiresAt: string | null }>('GET', '/api/nexus/status'),
  nexusOrgs: (refresh = false) => req<NexusOrg[]>('GET', `/api/nexus/organizations${refresh ? '?refresh=1' : ''}`),

  clients: () => req<Client[]>('GET', '/api/clients'),
  client: (id: string) => req<Client>('GET', `/api/clients/${id}`),
  /** Só organizações do Nexus: os dados do cliente vêm de lá. */
  createClient: (b: { nexusOrgId: string }) => req<Client>('POST', '/api/clients', b),
  updateClient: (id: string, b: { slug?: string }) => req<Client>('PATCH', `/api/clients/${id}`, b),
  deleteClient: (id: string) => req<null>('DELETE', `/api/clients/${id}`),

  createConnection: (clientId: string, b: { appId: string }) => req<Connection>('POST', `/api/clients/${clientId}/connections`, b),
  connection: (id: string) => req<Connection>('GET', `/api/connections/${id}`),
  updateConnection: (
    id: string,
    b: Partial<Pick<Connection, 'baseUrl' | 'auth' | 'extraHeaders' | 'requireAccessKey' | 'enabled'>>,
  ) => req<Connection>('PATCH', `/api/connections/${id}`, b),
  rotateCredentials: (id: string) => req<Connection>('POST', `/api/connections/${id}/rotate-credentials`),
  revokeTokens: (id: string) => req<{ revoked: number; connection: Connection }>('POST', `/api/connections/${id}/revoke-tokens`),
  /** OAuth 2.0 client_credentials: mesma chamada que o curl da tela de conexão. */
  oauthToken: async (clientId: string, clientSecret: string): Promise<OAuthToken> => {
    const r = await fetch('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j?.error_description ?? j?.error ?? `Erro ${r.status}`)
    return j
  },
  deleteConnection: (id: string) => req<null>('DELETE', `/api/connections/${id}`),
  connectionConfig: (id: string) => req<ClientConfig>('GET', `/api/connections/${id}/client-config`),
  invocations: (f: InvocationFilter = {}) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v)
    const qs = q.toString()
    return req<Invocation[]>('GET', `/api/invocations${qs ? `?${qs}` : ''}`)
  },
  invocation: (id: string) => req<InvocationDetail>('GET', `/api/invocations/${encodeURIComponent(id)}`),
}
