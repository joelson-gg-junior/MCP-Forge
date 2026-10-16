export type ParamLocation = 'path' | 'query' | 'header' | 'body' | 'form';

export interface ToolParam {
  /** Nome da propriedade no inputSchema da tool */
  name: string;
  /** Onde o valor vai na requisição upstream */
  in: ParamLocation;
  /** Nome original no upstream (ex.: header "X-Tenant-Id") */
  wireName?: string;
}

export type ToolStatus = 'draft' | 'approved' | 'disabled';

export interface Tool {
  id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  inputSchema: Record<string, unknown>;
  params: ToolParam[];
  status: ToolStatus;
  /** Tool só leitura (GET/HEAD) — exposto como annotation readOnlyHint */
  readOnly: boolean;
  updatedAt: string;
}

export type UpstreamAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; headerName: string; value: string; in?: 'header' | 'query' };

/** Credencial + URL + conexão que antes ficavam no App (mantido só para migrar bancos antigos). */
export interface LegacyAppConnection {
  auth?: UpstreamAuth;
  extraHeaders?: Record<string, string>;
  accessKey?: string;
  requireAccessKey?: boolean;
}

/** MCP App: a documentação importada e as tools revisadas (compartilhadas por todos os clientes). */
export interface App extends LegacyAppConnection {
  id: string;
  slug: string;
  name: string;
  /** URL base padrão da API (cada cliente pode sobrescrever no vínculo) */
  baseUrl: string;
  source: { kind: 'openapi3' | 'swagger2' | 'postman'; url?: string; title?: string; version?: string };
  createdAt: string;
  tools: Tool[];
}

/** Cliente (organização do Nexus). */
export interface Client {
  id: string;
  slug: string;
  name: string;
  tradeName?: string;
  document?: string;
  /** id da organização no Nexus */
  nexusOrgId?: string;
  createdAt: string;
}

/** Credenciais OAuth 2.0 (client_credentials) de uma conexão. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  createdAt: string;
}

/**
 * Conexão de um MCP App: dados da API (URL base, credencial, headers) + credenciais de acesso ao MCP.
 * - Laboratório (lab: true): configuração direta do MCP App, usada para testes. Endpoint /mcp/lab/<app>.
 * - Cliente: uma por cliente que usa o app, individual. Endpoint /mcp/<cliente>/<app>.
 */
export interface Connection {
  id: string;
  /** id do cliente, ou "lab" na conexão de laboratório */
  clientId: string;
  appId: string;
  lab?: boolean;
  /** URL base da API ('' = usa a URL base da documentação do App) */
  baseUrl: string;
  auth: UpstreamAuth;
  /** Headers fixos extras enviados ao upstream */
  extraHeaders: Record<string, string>;
  /** Credenciais OAuth 2.0 usadas para obter o Bearer token do endpoint MCP */
  oauth: OAuthClient;
  /** Exigir Bearer token no endpoint MCP */
  requireAccessKey: boolean;
  enabled: boolean;
  /** Chave estática antiga (não é mais aceita; mantida só por compatibilidade de leitura) */
  accessKey?: string;
  /** Conexão criada na migração: também responde no endereço antigo /mcp/<app> */
  legacyAppSlug?: string;
  createdAt: string;
}

/** Bearer token emitido pelo /oauth/token (guardado só o hash). */
export interface AccessToken {
  hash: string;
  connectionId: string;
  createdAt: string;
  expiresAt: string;
}

export interface Invocation {
  /** Código único da requisição (ex.: RQ-7K3P9XQ2), devolvido também na resposta do MCP */
  id: string;
  at: string;
  appId?: string;
  appSlug: string;
  clientId?: string;
  clientSlug?: string;
  clientName?: string;
  connectionId?: string;
  tool: string;
  toolId?: string;
  /** Status HTTP devolvido pela API do sistema base (null = não chegou a responder) */
  status: number | null;
  ok: boolean;
  ms: number;
  error?: string;
  /** Requisição JSON-RPC recebida pelo endpoint MCP e o resultado devolvido ao cliente */
  mcp?: { request: unknown; response: unknown };
  /** Requisição montada para a API do sistema base e a resposta crua dela */
  upstream?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    curl: string;
    response?: { status: number | null; headers?: Record<string, string>; body: string };
  };
}

/** Versão resumida usada na listagem. */
export type InvocationSummary = Omit<Invocation, 'mcp' | 'upstream'> & { method?: string; url?: string };

/* ------------------------------- acesso ------------------------------- */

/** Perfil de permissionamento. */
export interface Profile {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  /** perfil do sistema (Administrador): não pode ser excluído nem ter permissões removidas */
  system?: boolean;
  createdAt: string;
}

export type ViewMode = 'cards' | 'list';

export interface User {
  id: string;
  username: string;
  name: string;
  email?: string;
  /** scrypt$N$salt$hash */
  passwordHash: string;
  profileId: string;
  active: boolean;
  /** admin master: não pode ser excluído, desativado nem mudar de perfil */
  master?: boolean;
  prefs?: { viewMode?: Partial<Record<'apps' | 'clients', ViewMode>> };
  createdAt: string;
  lastLoginAt?: string;
}

export interface Session {
  hash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}
