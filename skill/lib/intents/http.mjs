// Same-origin HTTP router for /api/cockpit/v1. Transport adapters
// (serve --write and the standalone intents-service) supply authentication;
// this module enforces Origin/CSRF, body limits, validation, and private
// response headers, and never exposes consumer (agent) operations.
import crypto from 'node:crypto';
import {
  IntentError, LIMITS, PROTOCOL_VERSION, createIntent, listIntents, operatorArchive, publicIntent, replyIntent,
} from './core.mjs';
import { StoreError } from './store.mjs';
import { normalizeOrigins } from './origins.mjs';

export const API_PREFIX = '/api/cockpit/v1';
const BODY_TIMEOUT_MS = 10000;
const RATE = { perMinute: 30, burst: 10 };

const privateHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie, Authorization',
};

function sendJson(res, status, body, extra = {}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendError(res, error) {
  if (error instanceof IntentError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.field) body.error.field = error.field;
    const extra = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
    return sendJson(res, error.status, body, extra);
  }
  if (error instanceof StoreError) {
    return sendJson(res, 503, { error: { code: 'store_unavailable', message: 'Intent store is temporarily unavailable.' } }, { 'Retry-After': '5' });
  }
  return sendJson(res, 500, { error: { code: 'internal_error', message: 'Internal error.' } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      reject(new IntentError(408, 'body_timeout', 'Request body took too long.'));
      req.destroy();
    }, BODY_TIMEOUT_MS);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        clearTimeout(timer);
        reject(new IntentError(413, 'body_too_large', `Body exceeds ${limit} bytes.`));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseJson(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new IntentError(400, 'invalid_encoding', 'Body must be UTF-8.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IntentError(400, 'invalid_json', 'Body must be JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntentError(400, 'invalid_json', 'Body must be a JSON object.');
  return value;
}

export function csrfTokenFor(secret, principal) {
  return crypto.createHmac('sha256', secret).update(`csrf:${principal}`).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function validateWebhookUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Webhook URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Webhook URL must be an absolute http(s) URL');
  return parsed.href;
}

// Minimal, content-free wake notification. Failures are logged and ignored.
// `headers` (from --webhook-headers-file) are sent as-is and never logged.
export function notifyWebhook(url, event, intent, { log = () => {}, headers = {} } = {}) {
  if (!url) return Promise.resolve(false);
  const body = JSON.stringify({ event, intent_id: intent.intent_id, kind: intent.mode, at: new Date().toISOString() });
  return fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(3000),
  }).then((res) => {
    if (!res.ok) log(`webhook ${event} returned HTTP ${res.status}`);
    return res.ok;
  }).catch((error) => {
    log(`webhook ${event} failed: ${error.name}`);
    return false;
  });
}

export function createIntentsApi({ root, store, allowedOrigins, authenticate, csrfSecret, webhookUrl = null, webhookHeaders = {}, log = () => {} }) {
  if (!allowedOrigins || (typeof allowedOrigins !== 'function' && allowedOrigins.size === 0)) throw new Error('createIntentsApi requires at least one allowed origin');
  // A static allowlist is validated once here; a function (serve --write
  // loopback default) must return already-normalized origins.
  const fixed = typeof allowedOrigins === 'function' ? null : new Set(normalizeOrigins([...allowedOrigins]));
  const origins = () => fixed ?? allowedOrigins();
  if (!csrfSecret) throw new Error('createIntentsApi requires a CSRF secret');
  const buckets = new Map();

  function rateLimit(principal) {
    const nowMs = Date.now();
    const bucket = buckets.get(principal) ?? { tokens: RATE.burst, at: nowMs };
    bucket.tokens = Math.min(RATE.burst, bucket.tokens + ((nowMs - bucket.at) / 60000) * RATE.perMinute);
    bucket.at = nowMs;
    buckets.set(principal, bucket);
    if (bucket.tokens < 1) {
      const error = new IntentError(429, 'rate_limited', 'Too many requests; retry shortly.');
      error.retryAfter = Math.ceil(((1 - bucket.tokens) * 60) / RATE.perMinute);
      throw error;
    }
    bucket.tokens -= 1;
  }

  function checkMutation(req, principal) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null' || !origins().has(origin)) throw new IntentError(403, 'origin_denied', 'Origin not allowed.');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw new IntentError(403, 'origin_denied', 'Cross-site request denied.');
    if (!safeEqual(req.headers['x-cockpit-csrf'], csrfTokenFor(csrfSecret, principal))) throw new IntentError(403, 'csrf_invalid', 'Missing or invalid CSRF token.');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new IntentError(415, 'unsupported_media_type', 'Use application/json.');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new IntentError(415, 'unsupported_media_type', 'Compressed bodies are not accepted.');
    rateLimit(principal);
  }

  async function mutationBody(req, principal) {
    checkMutation(req, principal);
    return parseJson(await readBody(req, LIMITS.body_bytes));
  }

  async function route(req, res, url, principal) {
    const rest = url.pathname.slice(API_PREFIX.length) || '/';
    const method = req.method;

    if (rest === '/capabilities' && method === 'GET') {
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        features: { capture: true, page_comments: true, item_comments: false, replies: true, history: true },
        csrf_token: csrfTokenFor(csrfSecret, principal),
        limits: { body_bytes: LIMITS.body_bytes, operator_message_bytes: LIMITS.operator_message_bytes, payload_bytes: LIMITS.payload_bytes },
        type_hints: ['note', 'correction', 'question', 'todo', 'refresh-request'],
      });
    }

    if (rest === '/intents' && method === 'POST') {
      const body = await mutationBody(req, principal);
      const { intent, replayed } = store.mutate((state) => createIntent(state, root, body, { principal }));
      const location = `${API_PREFIX}/intents/${intent.intent_id}`;
      if (!replayed) notifyWebhook(webhookUrl, 'intent.created', intent, { log, headers: webhookHeaders });
      return sendJson(res, replayed ? 200 : 201, {
        intent_id: intent.intent_id,
        request_id: intent.request_id,
        state: intent.state,
        status: publicIntent(intent).status,
        version: intent.version,
        replayed,
        status_url: location,
      }, replayed ? {} : { Location: location });
    }

    if (rest === '/intents' && method === 'GET') {
      const view = url.searchParams.get('view') ?? 'open';
      if (view !== 'open' && view !== 'history') throw new IntentError(422, 'invalid_field', 'Expected view=open or view=history.', 'view');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.list_max) throw new IntentError(422, 'invalid_field', 'limit must be 1-100.', 'limit');
      const { items, next_cursor: nextCursor } = listIntents(store.read(), { view, limit, cursor: url.searchParams.get('cursor') });
      return sendJson(res, 200, { view, items: items.map(publicIntent), next_cursor: nextCursor });
    }

    const match = /^\/intents\/([0-9a-f-]{36})(\/replies|\/archive)?$/.exec(rest);
    if (match) {
      const [, id, action] = match;
      if (!action && method === 'GET') {
        const intent = store.read().intents.find((item) => item.intent_id === id);
        if (!intent) throw new IntentError(404, 'intent_not_found', 'Intent not found.');
        return sendJson(res, 200, publicIntent(intent));
      }
      if (action === '/replies' && method === 'POST') {
        const body = await mutationBody(req, principal);
        const { intent, replayed } = store.mutate((state) => replyIntent(state, id, body, { principal }));
        if (!replayed) notifyWebhook(webhookUrl, 'intent.reply', intent, { log, headers: webhookHeaders });
        return sendJson(res, 200, { intent_id: intent.intent_id, state: intent.state, status: publicIntent(intent).status, version: intent.version, replayed });
      }
      if (action === '/archive' && method === 'POST') {
        const body = await mutationBody(req, principal);
        const { intent, replayed } = store.mutate((state) => operatorArchive(state, id, body, { principal }));
        return sendJson(res, 200, { intent_id: intent.intent_id, state: intent.state, status: publicIntent(intent).status, version: intent.version, replayed });
      }
      throw new IntentError(405, 'method_not_allowed', 'Method not allowed.');
    }
    if (['/capabilities', '/intents'].includes(rest)) throw new IntentError(405, 'method_not_allowed', 'Method not allowed.');
    throw new IntentError(404, 'not_found', 'Unknown API route.');
  }

  // Returns true when the request was an API request (handled), else false.
  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    (async () => {
      if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
        throw new IntentError(400, 'credential_in_url', 'Credentials are not accepted in URLs.');
      }
      const principal = await authenticate(req);
      if (!principal) throw new IntentError(401, 'authentication_required', 'Authentication required.');
      await route(req, res, url, principal);
    })().catch((error) => {
      if (!(error instanceof IntentError) && !(error instanceof StoreError)) log(`intents api error: ${error.name}`);
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
    return true;
  }

  return { handle };
}
