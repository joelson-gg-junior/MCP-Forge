/**
 * Carrega server/.env (se existir) antes de qualquer outro módulo ler process.env.
 * Variáveis já definidas no ambiente têm prioridade sobre o arquivo.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const file = process.env.ENV_FILE ?? path.resolve(process.cwd(), '.env');
if (existsSync(file)) {
  const before = { ...process.env };
  process.loadEnvFile(file);
  Object.assign(process.env, before);
}
