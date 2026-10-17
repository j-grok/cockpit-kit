#!/usr/bin/env node
// Standalone loopback operator-intents service for deployments where an
// authenticating reverse proxy already fronts the static Cockpit server.
// The proxy routes /api/cockpit/v1/* here and injects:
//   X-Cockpit-Proxy-Secret: <contents of the proxy secret file>  (required)
//   X-Cockpit-Principal:    <authenticated operator login>       (optional)
// The proxy must strip both headers from client requests. Direct requests
// without the secret are rejected, so loopback reachability alone is not
// authentication.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentError, resolveRoot, validateCockpitRoot } from '../lib/config.mjs';
import { assertNode20, expandHome } from '../lib/paths.mjs';
import { parseOrigin } from '../lib/serve-config.mjs';
import { createIntentsApi, validateWebhookUrl } from '../lib/intents/http.mjs';
import { IntentStore } from '../lib/intents/store.mjs';

export const DEFAULT_INTENTS_PORT = 18767;
const PRINCIPAL_RE = /^[A-Za-z0-9@._+-]{1,128}$/;

function usage() {
  return `Usage: node scripts/intents-service.mjs --origin <exact-origin> [options]

Options:
  --root <path>               Cockpit root (default: configured root)
  --origin <origin>           Exact public browser origin, e.g. https://cockpit.example (required, repeatable)
  --host <host>               Loopback host to bind (default: 127.0.0.1)
  --port <port>               Port to bind (default: ${DEFAULT_INTENTS_PORT})
  --proxy-secret-file <path>  Shared proxy secret (default: <state-dir>/proxy-secret, created 0600)
  --webhook-url <url>         POST {event,intent_id,kind} on new intents/replies (or COCKPIT_INTENTS_WEBHOOK_URL)
  --help                      Show this help
`;
}

function take(argv, i, arg) {
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new ArgumentError(`${arg} requires a value`);
  return value;
}

export function parseServiceArgs(argv, env) {
  const options = { rootArgs: [], origins: [], host: '127.0.0.1', port: DEFAULT_INTENTS_PORT, webhookUrl: env.COCKPIT_INTENTS_WEBHOOK_URL ?? null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = take(argv, i, name);
      i += 1;
      return v;
    };
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--root' || name === '--cockpit-root') options.rootArgs.push(name, value());
    else if (name === '--origin') options.origins.push(parseOrigin(value(), '--origin'));
    else if (name === '--host') {
      options.host = value();
      if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) throw new ArgumentError('--host must be loopback (127.0.0.1, localhost, ::1)');
    } else if (name === '--port') {
      const raw = value();
      options.port = Number.parseInt(raw, 10);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || String(options.port) !== raw) throw new ArgumentError('--port must be 0-65535');
    } else if (name === '--proxy-secret-file') options.secretFile = path.resolve(expandHome(value(), env));
    else if (name === '--webhook-url') options.webhookUrl = value();
    else throw new ArgumentError(`Unknown option: ${arg}`);
  }
  return options;
}

export function loadOrCreateSecret(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, `${crypto.randomBytes(32).toString('hex')}\n`);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Proxy secret must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('Proxy secret file must not be group/world accessible (chmod 600)');
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error('Proxy secret is too short');
  return secret;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createIntentsService({ root, origins, secret, host = '127.0.0.1', port = DEFAULT_INTENTS_PORT, webhookUrl = null, env = process.env, log = () => {} }) {
  if (!origins?.length) throw new ArgumentError('intents-service requires at least one --origin');
  if (!secret) throw new Error('intents-service requires a proxy secret');
  const store = new IntentStore({ root, env });
  let server;
  const api = createIntentsApi({
    root: store.root,
    store,
    allowedOrigins: new Set(origins),
    authenticate: (req) => {
      if (!safeEqual(req.headers['x-cockpit-proxy-secret'], secret)) return null;
      const principal = String(req.headers['x-cockpit-principal'] ?? 'operator').toLowerCase();
      return PRINCIPAL_RE.test(principal) ? principal : null;
    },
    csrfSecret: crypto.createHmac('sha256', secret).update('cockpit-intents-csrf').digest(),
    webhookUrl: validateWebhookUrl(webhookUrl),
    log,
  });
  server = http.createServer((req, res) => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
    if (!hosts.has(req.headers.host ?? '')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end('Bad Host header\n');
    }
    if (api.handle(req, res)) return undefined;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    return res.end('Not found\n');
  });
  server.intentStore = store;
  return server;
}

async function main() {
  assertNode20();
  const options = parseServiceArgs(process.argv.slice(2), process.env);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const resolved = resolveRoot({ argv: options.rootArgs, env: process.env, stderr: process.stderr });
  const root = fs.realpathSync.native(validateCockpitRoot(resolved.root).root);
  const store = new IntentStore({ root, env: process.env });
  const secretFile = options.secretFile ?? path.join(store.stateDir, 'proxy-secret');
  const secret = loadOrCreateSecret(secretFile);
  const server = createIntentsService({
    root, origins: options.origins, secret, host: options.host, port: options.port, webhookUrl: options.webhookUrl,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  server.on('error', (error) => {
    process.stderr.write(`intents-service failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    process.stdout.write(`Cockpit root: ${root}\n`);
    process.stdout.write(`Intents API: http://${options.host === '::1' ? '[::1]' : options.host}:${address.port}/api/cockpit/v1\n`);
    process.stdout.write(`Allowed origins: ${options.origins.join(', ')}\n`);
    process.stdout.write(`State: ${store.file}\n`);
    process.stdout.write(`Proxy secret file: ${secretFile}\n`);
  });
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ArgumentError ? error.message : `${error.name}: ${error.message}`}\n`);
    process.exitCode = 1;
  });
}
