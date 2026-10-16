/**
 * Geração automática (IA) da descrição da tool e dos parâmetros, via API da OpenAI
 * (Chat Completions com function calling para garantir a saída estruturada).
 *
 * Configuração (server/.env):
 *   OPENAI_API_KEY   chave da API (obrigatória para habilitar)
 *   OPENAI_MODEL     modelo (padrão gpt-4o-mini)
 *   OPENAI_BASE_URL  padrão https://api.openai.com/v1 (aceita endpoints compatíveis)
 *   OPENAI_ORG_ID    (opcional) organização
 *   AI_LANGUAGE      idioma das descrições (padrão "português do Brasil")
 */
import type { App, Tool } from './types.js';

export interface AiDocs {
  description: string;
  /** descrição por nome de parâmetro (propriedades de primeiro nível do inputSchema) */
  params: Record<string, string>;
  model: string;
}

const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BASE = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const LANG = () => process.env.AI_LANGUAGE || 'português do Brasil';
const TIMEOUT = Number(process.env.AI_TIMEOUT_MS ?? 90_000);

export const aiConfigured = () => !!process.env.OPENAI_API_KEY;
export const aiModel = MODEL;

const httpError = (message: string, statusCode = 502) => Object.assign(new Error(message), { statusCode });

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function systemPrompt() {
  return `Você documenta endpoints de API HTTP que viram tools de um servidor MCP, usadas por agentes de IA (LLMs).
O agente escolhe a tool e preenche os argumentos só com base no que você escrever, então seja preciso e objetivo.

Escreva em ${LANG()}.

Descrição da tool (até ~700 caracteres, 2 a 4 frases, texto corrido, sem markdown):
- Comece pelo que a tool faz em termos de negócio (não repita "GET /path").
- Diga quando usar e quais informações são necessárias para chamá-la.
- Diga o que ela retorna (principais campos), se der para inferir.
- Se o método não for GET/HEAD, deixe claro que ela cria, altera ou remove dados.
- Não invente regras ou campos que não estejam no contexto; na dúvida, seja genérico.

Descrição de cada parâmetro (até ~200 caracteres):
- O que é, formato esperado e um exemplo quando ajudar (ex.: "CPF ou CNPJ só com números, ex.: 12345678900").
- Para o parâmetro "body", resuma os campos principais do corpo.
- Descreva todos os parâmetros listados, usando exatamente os nomes informados.

Responda chamando a função salvar_documentacao.`;
}

function userPrompt(app: App, tool: Tool, sampleResponse?: string) {
  const schema = tool.inputSchema as any;
  const locs = Object.fromEntries(tool.params.map((p) => [p.name, p.wireName && p.wireName !== p.name ? `${p.in} (${p.wireName})` : p.in]));
  return [
    `API: ${app.name}${app.source.title && app.source.title !== app.name ? ` (${app.source.title})` : ''}`,
    `Endpoint: ${tool.method} ${tool.path}`,
    `Nome da tool: ${tool.name}`,
    `Descrição atual (da documentação, pode estar vazia ou ruim):\n${clip(tool.description || '(vazia)', 2000)}`,
    `Onde cada parâmetro vai na requisição: ${JSON.stringify(locs)}`,
    `inputSchema:\n${clip(JSON.stringify(schema, null, 2), 6000)}`,
    sampleResponse ? `Exemplo real de resposta da API (truncado):\n${clip(sampleResponse, 2500)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Chama POST /chat/completions e traduz os erros da OpenAI para mensagens claras. */
async function openaiChat(payload: Record<string, unknown>): Promise<any> {
  if (!aiConfigured()) throw httpError('IA não configurada. Defina OPENAI_API_KEY no arquivo server/.env e reinicie o servidor.', 503);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  };
  if (process.env.OPENAI_ORG_ID) headers['openai-organization'] = process.env.OPENAI_ORG_ID;

  const res = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: MODEL(), ...payload }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((e) => {
    throw httpError(
      e?.name === 'TimeoutError' ? 'A IA demorou demais para responder.' : `Não foi possível conectar à API da OpenAI: ${e?.cause?.message ?? e?.message ?? e}`,
    );
  });

  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* corpo não-JSON */
  }
  if (!res.ok) {
    const msg = j?.error?.message ?? text.slice(0, 300);
    const code = j?.error?.code ?? '';
    if (res.status === 401) throw httpError('OPENAI_API_KEY inválida.', 502);
    if (res.status === 404 || code === 'model_not_found') throw httpError(`Modelo "${MODEL()}" não encontrado ou sem acesso. Ajuste OPENAI_MODEL no .env. (${msg})`, 502);
    if (code === 'insufficient_quota') throw httpError('Conta da OpenAI sem créditos/cota disponível.', 429);
    if (res.status === 429) throw httpError('Limite de uso da API da OpenAI atingido. Tente de novo em instantes.', 429);
    throw httpError(`API da OpenAI respondeu HTTP ${res.status}: ${msg}`);
  }
  return j;
}

/** Gera descrição + descrições de parâmetros. Não salva nada: quem chama decide. */
export async function generateToolDocs(app: App, tool: Tool, sampleResponse?: string): Promise<AiDocs> {
  const paramNames = Object.keys((tool.inputSchema as any).properties ?? {});

  const j = await openaiChat({
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(app, tool, sampleResponse) },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'salvar_documentacao',
            description: 'Salva a descrição da tool e dos parâmetros.',
            parameters: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Descrição da tool' },
                parameters: {
                  type: 'object',
                  description: 'Descrição de cada parâmetro, pelo nome',
                  properties: Object.fromEntries(paramNames.map((n) => [n, { type: 'string' }])),
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['description', 'parameters'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'salvar_documentacao' } },
    });
  const call = j?.choices?.[0]?.message?.tool_calls?.find((c: any) => c?.function?.name === 'salvar_documentacao');
  let input: any;
  try {
    input = JSON.parse(call?.function?.arguments ?? '');
  } catch {
    input = undefined;
  }
  if (!input || typeof input.description !== 'string') throw httpError('A IA não devolveu a documentação no formato esperado.');

  const params: Record<string, string> = {};
  for (const n of paramNames) {
    const v = input.parameters?.[n];
    if (typeof v === 'string' && v.trim()) params[n] = clip(v.trim(), 600);
  }
  return { description: clip(input.description.trim(), 4000), params, model: MODEL() };
}

/* ---------------------- teste da tool por mensagem ---------------------- */

export interface AiToolTest<R> {
  model: string;
  /** a IA decidiu chamar a tool? */
  toolCalled: boolean;
  /** argumentos que a IA montou a partir da mensagem */
  args?: Record<string, unknown>;
  /** resultado da chamada real à API */
  result?: R;
  /** resposta final da IA ao usuário (ou explicação de por que não chamou a tool) */
  reply: string;
}

/**
 * Simula um agente: a IA lê a mensagem, decide se chama a tool e com quais argumentos,
 * a tool é executada de verdade (execute) e a IA responde com base no retorno.
 */
export async function testToolWithMessage<R extends { status: number | null; text: string; error?: string }>(
  tool: Tool,
  schema: Record<string, unknown>,
  message: string,
  execute: (args: Record<string, unknown>) => Promise<R>,
): Promise<AiToolTest<R>> {
  const fn = { type: 'function', function: { name: tool.name, description: clip(tool.description || `${tool.method} ${tool.path}`, 4000), parameters: schema } };
  const messages: any[] = [
    {
      role: 'system',
      content: `Você é um assistente que atende o usuário usando a ferramenta disponível. Responda em ${LANG()}.
Se o pedido puder ser atendido pela ferramenta, chame-a com os argumentos corretos tirados da mensagem.
Se faltar alguma informação obrigatória, não invente: explique o que falta.`,
    },
    { role: 'user', content: message },
  ];

  const first = await openaiChat({ messages, tools: [fn], tool_choice: 'auto' });
  const msg = first?.choices?.[0]?.message ?? {};
  const call = (msg.tool_calls ?? []).find((c: any) => c?.function?.name === tool.name);
  if (!call) return { model: MODEL(), toolCalled: false, reply: String(msg.content ?? '').trim() || '(a IA não respondeu)' };

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    throw httpError('A IA montou argumentos que não são JSON válido.');
  }
  const result = await execute(args);

  // devolve o retorno para a IA responder ao usuário, como um agente faria
  const toolContent = result.error ? `Erro: ${result.error}` : `HTTP ${result.status}\n${clip(result.text, 12000)}`;
  const second = await openaiChat({
    messages: [...messages, { role: 'assistant', content: msg.content ?? null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: toolContent }],
    tools: [fn],
    tool_choice: 'none',
  });
  const reply = String(second?.choices?.[0]?.message?.content ?? '').trim();
  return { model: MODEL(), toolCalled: true, args, result, reply };
}
