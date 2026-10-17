import fs from 'node:fs';
import path from 'node:path';
import { ArgumentError, resolveRoot, validateCockpitRoot } from './config.mjs';
import { parseToml } from './toml.mjs';
import { normalizeOrigin, normalizeOrigins } from './intents/origins.mjs';

export const DEFAULT_SERVE_HOST = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 18765;

function takeValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new ArgumentError(`${arg} requires a value`);
  return value;
}

function takePathValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === '--') {
    const escaped = argv[index + 2];
    if (!escaped) throw new ArgumentError(`${arg} requires a path argument`);
    return { value: escaped, index: index + 2 };
  }
  if (!value || value.startsWith('-')) throw new ArgumentError(`${arg} requires a path argument`);
  return { value, index: index + 1 };
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function parseHost(value, source) {
  if (typeof value !== 'string' || value.trim() === '') throw new ArgumentError(`${source} must be a non-empty string`);
  if (!isLoopbackHost(value)) throw new ArgumentError(`${source} must be localhost, 127.0.0.1, ::1, or [::1]`);
  return value;
}

function parsePort(value, source) {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(value).trim() !== String(port)) {
    throw new ArgumentError(`${source} must be an integer from 0 to 65535`);
  }
  return port;
}

export function parseOrigin(value, source = '--origin') {
  return normalizeOrigin(value, source);
}

function parseArgs(argv) {
  const flags = { rootArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      flags.rootArgs.push(...argv.slice(index));
      break;
    }
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--host') {
      flags.host = parseHost(takeValue(argv, index, arg), '--host');
      index += 1;
    } else if (arg.startsWith('--host=')) flags.host = parseHost(arg.slice('--host='.length), '--host');
    else if (arg === '--port') {
      flags.port = parsePort(takeValue(argv, index, arg), '--port');
      index += 1;
    } else if (arg.startsWith('--port=')) flags.port = parsePort(arg.slice('--port='.length), '--port');
    else if (arg === '--write') flags.write = true;
    else if (arg === '--origin') {
      flags.origins = [...(flags.origins ?? []), parseOrigin(takeValue(argv, index, arg), '--origin')];
      index += 1;
    } else if (arg.startsWith('--origin=')) flags.origins = [...(flags.origins ?? []), parseOrigin(arg.slice('--origin='.length), '--origin')];
    else if (arg === '--webhook-headers-file') {
      flags.webhookHeadersFile = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--webhook-headers-file=')) flags.webhookHeadersFile = arg.slice('--webhook-headers-file='.length);
    else if (arg === '--webhook-url') {
      flags.webhookUrl = takeValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--webhook-url=')) flags.webhookUrl = arg.slice('--webhook-url='.length);
    else if (arg === '--no-auth') flags.auth = false;
    else if (arg === '--auth') flags.auth = true;
    else if (arg === '--root' || arg === '--cockpit-root') {
      const pathValue = takePathValue(argv, index, arg);
      flags.rootArgs.push(arg, pathValue.value);
      index = pathValue.index;
    } else if (arg.startsWith('--root=') || arg.startsWith('--cockpit-root=')) flags.rootArgs.push(arg);
    else throw new ArgumentError(`Unknown option: ${arg}`);
  }
  return flags;
}

function readServeFile(root) {
  const file = path.join(root, '.cockpit', 'serve.toml');
  if (!fs.existsSync(file)) return { file, values: {} };
  const values = parseToml(fs.readFileSync(file, 'utf8'));
  return { file, values };
}

function serveFileOptions(values) {
  const options = {};
  if (Object.hasOwn(values, 'host')) {
    options.host = parseHost(values.host, '.cockpit/serve.toml host');
  }
  if (Object.hasOwn(values, 'port')) options.port = parsePort(values.port, '.cockpit/serve.toml port');
  if (Object.hasOwn(values, 'auth')) {
    if (typeof values.auth !== 'boolean') throw new ArgumentError('.cockpit/serve.toml auth must be true or false');
    options.auth = values.auth;
  }
  return options;
}

export function parseServeConfig({ argv = [], env, stderr } = {}) {
  if (!env) throw new Error('parseServeConfig requires an explicit env object');
  const flags = parseArgs(argv);
  if (flags.help) return { help: true };

  const resolved = resolveRoot({ argv: flags.rootArgs, env, stderr });
  const validated = validateCockpitRoot(resolved.root);
  const root = fs.realpathSync.native(validated.root);
  const serveFile = readServeFile(root);
  const fileOptions = serveFileOptions(serveFile.values);

  const auth = flags.auth ?? fileOptions.auth ?? true;
  const write = flags.write === true;
  if (write && !auth) throw new ArgumentError('serve --write requires authentication; --write --no-auth is not supported');
  return {
    root,
    write,
    origins: normalizeOrigins(flags.origins ?? []),
    webhookUrl: flags.webhookUrl ?? env.COCKPIT_INTENTS_WEBHOOK_URL ?? null,
    webhookHeadersFile: flags.webhookHeadersFile ?? (env.COCKPIT_INTENTS_WEBHOOK_HEADERS_FILE || null),
    host: flags.host ?? fileOptions.host ?? DEFAULT_SERVE_HOST,
    port: flags.port ?? fileOptions.port ?? DEFAULT_SERVE_PORT,
    auth,
    configPath: resolved.configPath,
    source: resolved.source,
    serveConfigPath: serveFile.file,
  };
}
