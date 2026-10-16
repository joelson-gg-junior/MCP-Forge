# MCP Forge

Transforma a documentação de uma API (OpenAPI 3, Swagger 2 ou Postman) em um **servidor MCP** pronto para o Cherry Studio, o Claude Desktop ou qualquer cliente MCP.

```
Documentação ─▶ MCP App (tools revisadas)
                 ├─ Laboratório: dados da API de teste + conexão própria ─▶ /mcp/lab/<app>
                 └─ Cliente (Nexus): dados da API do cliente + conexão própria ─▶ /mcp/<cliente>/<app>
Conexão: client_id + client_secret ─▶ POST /oauth/token ─▶ Bearer token (24 h) ─▶ endpoint MCP
```

## Recursos

- **Importação**: OpenAPI 3.x e Swagger 2.0 (JSON ou YAML, por link ou colado) e Postman Collection v2.x. Links do Postman Documenter (`documenter.getpostman.com/view/...`) são convertidos automaticamente.
- **Geração de tools**: uma tool por endpoint, com `inputSchema` montado a partir de path, query, header e body. Resolve `$ref` (inclusive circulares) e converte `nullable`.
- **Laboratório**: cada MCP App tem uma configuração direta, usada para testes (playground e `/mcp/lab/<app>`), com dados da API e conexão próprios.
- **Clientes**: cadastro a partir das organizações do Nexus. Cada cliente vincula os MCP Apps que usa e tem, por app, dados da API (URL base, credencial, headers) e conexão (OAuth, tokens) individuais (`Cliente › App › Dados da API / Conexão`).
- **Autenticação OAuth 2.0**: cada conexão (laboratório ou cliente) tem `client_id` e `client_secret`. O cliente MCP chama `POST /oauth/token` (`grant_type=client_credentials`) e recebe um Bearer token válido por 24 h, aceito só no endpoint daquela conexão. A tela de conexão mostra o curl pronto, autentica e copia o token, e gera novas credenciais (revogando os tokens anteriores).
- **Revisão humana**: só tools **aprovadas** aparecem no MCP. Se você editar uma tool aprovada, ela volta para rascunho.
- **Descrições com IA**: botão **Gerar com IA** no painel da tool (preenche descrição e parâmetros para revisão, sem salvar) e geração em lote para as tools selecionadas ou com qualidade < 80 (salva e volta para rascunho). Usa a API da OpenAI (Chat Completions com function calling) e, quando existir, uma resposta real da API registrada nos logs como contexto.
- **Qualidade**: nota de 0 a 100 por tool, com dicas (descrição curta, parâmetros sem descrição, escrita sem aviso). Dá para aprovar em lote as que tiverem nota ≥ 80.
- **Playground**: testa a chamada real contra a API antes de aprovar.
- **Credencial upstream (por cliente)**: nenhuma, Bearer, Basic ou API key (em header ou query), mais headers extras. Os segredos aparecem mascarados na interface.
- **Segurança do endpoint MCP**: `Authorization: Bearer <token OAuth>`; tokens guardados só como hash. Chamadas para fora da URL base são bloqueadas.
- **Reimportação**: compara pelo método + path. Tools cujo contrato mudou voltam para rascunho; as demais mantêm edições e aprovação.
- **Logs de Requisições**: cada chamada recebe um código (`RQ-…`, também devolvido na resposta do MCP), com a requisição recebida pelo MCP, o curl enviado à API, o retorno da API e o retorno do MCP. Filtros por cliente, app, código, tool, status e data/hora.

## Acesso

A interface exige login. Na primeira execução é criado o **admin master** `joelson` (senha inicial `joel777`; troque em **Alterar senha**, no rodapé do menu). Ele não pode ser excluído, desativado nem mudar de perfil.

Em **Administração › Acesso** ficam os usuários e os perfis de permissionamento:

| Permissão | O que libera |
| --- | --- |
| `apps.view` | Ver MCP Apps e tools |
| `apps.edit` | Importar e editar MCP Apps, tools e laboratório (inclui IA) |
| `tools.approve` | Aprovar, voltar para rascunho e desativar tools |
| `apps.test` | Testar tools (playground e teste com IA) |
| `clients.view` / `clients.edit` | Ver / cadastrar clientes e configurar vínculos |
| `credentials.manage` | Ver e gerar client_id/secret e tokens das conexões |
| `logs.view` | Ver Logs de Requisições |
| `access.manage` | Gerenciar usuários e perfis |

Perfis iniciais: **Administrador** (tudo, do sistema), **Operador** e **Somente leitura**. A sessão fica em cookie `HttpOnly` e vale `SESSION_TTL_HOURS` (padrão 12 h). Os endpoints `/mcp/...` e `/oauth/token` não usam esse login: eles têm a autenticação OAuth de cada conexão.

As telas **Clientes** e **MCP Apps** têm visualização em cards ou lista; a última escolha fica salva no perfil do usuário.

## Rodando

### Docker (recomendado)

```bash
docker compose up -d --build
# abra http://localhost:8080
```

### Node 22+

```bash
npm run install:all
npm run build
npm start            # http://localhost:8080
```

Desenvolvimento com hot reload: `npm run dev`. A API sobe em `:8080` e a interface em `http://localhost:5173`.

### Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `8080` | Porta HTTP |
| `PUBLIC_URL` | `http://localhost:8080` | URL que os clientes MCP usam (aparece na config do Cherry) |
| `DATA_DIR` | `./data` | Onde fica o `db.json` |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Timeout das chamadas à API de destino |
| `NEXUS_API_URL` | `https://api.nexus.matrixdobrasil.ai` | API do Nexus |
| `NEXUS_EMAIL` / `NEXUS_PASSWORD` | — | Login usado para listar as organizações (o token é reaproveitado até expirar e fica em `DATA_DIR/nexus-session.json`) |
| `MAX_LOGS` | `1000` | Quantos logs de requisição manter |
| `LOG_BODY_MAX` | `20000` | Tamanho máximo de cada corpo guardado no log |
| `OPENAI_API_KEY` | — | Habilita a geração de descrições com IA |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modelo usado na geração |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Endpoint da API (aceita serviços compatíveis com a OpenAI) |
| `AI_LANGUAGE` | `português do Brasil` | Idioma das descrições geradas |
| `SESSION_TTL_HOURS` | `12` | Validade da sessão de login da interface |
| `OAUTH_TOKEN_TTL_SECONDS` | `86400` | Validade do Bearer token emitido em `/oauth/token` (24 h) |

As variáveis podem ficar em `server/.env` (veja `server/.env.example`); esse arquivo não vai para o Git.

## Conectando no Cherry Studio

1. No MCP Forge, abra **Cliente › MCP App › Conexão** (ou **MCP App › Laboratório · Conexão**) e clique em **Autenticar e copiar token**.
2. No Cherry Studio, vá em **Configurações → Servidores MCP → Adicionar servidor**.
3. Tipo: **Streamable HTTP (`streamableHttp`)**. URL: `http://localhost:8080/mcp/<cliente>/<app>`.
4. Em headers, adicione `Authorization=Bearer <token>`. O token expira em 24 h; gere outro quando expirar.
5. Salve, ative o servidor e habilite o MCP no chat.

Outra opção: copie o JSON da aba e use **Importar do JSON** no Cherry.

> Se o Cherry Studio roda em outra máquina, suba o Forge com `PUBLIC_URL=http://<ip-ou-dominio>:8080`.

## API REST

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/apps/import` | `{ url? , content?, name?, baseUrl? }` importa e cria o app |
| `GET` | `/api/apps` / `/api/apps/:id` | lista / detalhe com tools e nota de qualidade |
| `PATCH` | `/api/apps/:id` | nome, `baseUrl` padrão |
| `POST` | `/api/apps/:id/reimport` | reimporta a documentação |
| `PATCH` | `/api/apps/:id/tools/:toolId` | nome, descrição, `paramDescriptions`, `status` |
| `POST` | `/api/apps/:id/tools/bulk` | `{ ids, status }` |
| `POST` | `/api/apps/:id/tools/:toolId/ai-describe` | sugestão da IA `{ description, params, model }` (não salva) |
| `POST` | `/api/apps/:id/tools/:toolId/test` | executa a chamada real (playground); `connectionId` opcional usa a credencial de um cliente |
| `GET` | `/api/nexus/organizations` | organizações do Nexus (`?refresh=1` ignora o cache de 60 s) |
| `GET` / `POST` | `/api/clients` | lista / cadastra cliente `{ nexusOrgId }` ou `{ name, tradeName?, document? }` |
| `GET` / `PATCH` / `DELETE` | `/api/clients/:id` | detalhe / `name`, `tradeName`, `slug` / exclui (com os vínculos) |
| `POST` | `/api/clients/:id/connections` | vincula um MCP App `{ appId, baseUrl?, auth?, extraHeaders?, requireAccessKey? }` |
| `GET` / `PATCH` / `DELETE` | `/api/connections/:id` | conexão (cliente ou laboratório): `baseUrl`, `auth`, `extraHeaders`, `requireAccessKey`, `enabled` |
| `POST` | `/api/connections/:id/rotate-credentials` | novo `client_id`/`client_secret` (revoga os tokens) |
| `POST` | `/api/connections/:id/revoke-tokens` | revoga os tokens ativos |
| `POST` | `/oauth/token` | OAuth 2.0 client_credentials → `{ access_token, token_type: "Bearer", expires_in: 86400 }` |
| `GET` | `/api/connections/:id/client-config` | JSON para o Cherry Studio |
| `GET` | `/api/invocations` | logs (`client`, `app`, `id`, `tool`, `status`, `from`, `to`) |
| `GET` | `/api/invocations/:id` | detalhe do log (MCP, curl e retornos) |
| `POST` | `/mcp/:cliente/:app` · `/mcp/lab/:app` | endpoint MCP do cliente / do laboratório (Streamable HTTP, stateless) |

Bancos antigos são migrados automaticamente: a credencial de cada app vira a configuração de **laboratório**, e o endereço antigo `/mcp/<app>` continua respondendo (agora com Bearer token OAuth do laboratório). A chave estática `mcpf_…` deixou de ser aceita.

## Testes

```bash
npm test
```

O teste e2e sobe uma API mock e o Forge, importa os três formatos e usa o cliente oficial do SDK MCP (`listTools` / `callTool`) para validar auth, aprovação, path/query/body, segredos e reimportação.

## Limitações conhecidas (MVP)

- Os dados ficam em um arquivo JSON e os segredos são gravados sem criptografia. Para produção, troque por um banco de dados e um cofre de segredos.
- A interface de administração não tem autenticação. Rode em rede confiável ou atrás de um proxy com login.
- Ainda não implementado: crawl de documentação em HTML, OAuth2 upstream (client credentials), multi-tenant/overlay por empresa, recipes e versionamento semver.

## Arquitetura

```
server/src
  importer.ts   OpenAPI/Swagger/Postman → tools (+ nota de qualidade)
  upstream.ts   executa a chamada HTTP da tool (auth, path/query/body, bloqueio de URL)
  mcp.ts        endpoint MCP Streamable HTTP por cliente × app (SDK oficial)
  nexus.ts      login e organizações do Nexus
  ai.ts         descrições de tools e parâmetros com IA (OpenAI)
  access.ts     login, usuários, perfis e permissões da interface
  index.ts      API REST + arquivos estáticos da interface
  store.ts      persistência em JSON (escrita atômica)
web/src         React + Vite (Apps, Importar, Tools, Configuração, Conectar, Invocações)
```
