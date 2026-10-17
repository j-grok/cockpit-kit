// Shared validation, target resolution, and lifecycle for operator intents.
// Transport-neutral: used by the HTTP router (browser side) and the consumer
// CLI (agent side). Only `operator_message` and operator follow-up messages
// are operator direction; everything in `payload` is untrusted data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPathInside } from '../paths.mjs';

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  body_bytes: 32768,
  operator_message_bytes: 8192,
  payload_bytes: 16384,
  target_bytes: 2048,
  url_bytes: 2048,
  replies_per_intent: 20,
  summary_bytes: 4096,
  question_bytes: 2048,
  list_max: 100,
});
export const TYPE_HINTS = Object.freeze(['note', 'correction', 'question', 'todo', 'refresh-request']);
export const OUTCOMES = Object.freeze(['changed', 'already_satisfied', 'answered', 'declined']);
export const STATES = Object.freeze(['open', 'needs-input', 'addressed', 'archived']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const PAYLOAD_KEYS = new Set(['url', 'text', 'selected_text', 'title']);
const CREATE_KEYS = new Set(['schema_version', 'request_id', 'mode', 'type_hint', 'operator_message', 'target', 'payload']);
const REPLY_KEYS = new Set(['request_id', 'operator_message', 'version']);
const ARCHIVE_KEYS = new Set(['request_id', 'version']);
const EXCLUDED_SEGMENTS = new Set(['node_modules', 'attachments']);

export class IntentError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'IntentError';
    this.status = status;
    this.code = code;
    if (field) this.field = field;
  }
}

const bytes = (value) => Buffer.byteLength(value, 'utf8');
const now = () => new Date().toISOString();

function invalid(field, message = 'Invalid value.') {
  return new IntentError(422, 'invalid_field', message, field);
}

function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, 'Expected a JSON object.');
}

function assertKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new IntentError(422, 'unknown_field', 'This field is not accepted.', field ? `${field}.${key}` : key);
  }
}

function boundedString(value, field, max, { required = false, nonBlank = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid(field, 'Required.');
    return undefined;
  }
  if (typeof value !== 'string') throw invalid(field, 'Expected a string.');
  if (value.includes('\0')) throw invalid(field, 'NUL is not allowed.');
  if (bytes(value) > max) throw invalid(field, `Longer than ${max} bytes.`);
  if (nonBlank && value.trim() === '') throw invalid(field, 'Must contain text.');
  return value;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function requestId(value, field = 'request_id') {
  if (!isUuid(value)) throw invalid(field, 'Expected a lowercase UUID.');
  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validatePayload(payload) {
  if (payload === undefined || payload === null) return null;
  assertObject(payload, 'payload');
  assertKnownKeys(payload, PAYLOAD_KEYS, 'payload');
  const out = {};
  for (const key of PAYLOAD_KEYS) {
    const value = boundedString(payload[key], `payload.${key}`, LIMITS.payload_bytes);
    if (value !== undefined) out[key] = value;
  }
  if (out.url !== undefined) {
    if (bytes(out.url) > LIMITS.url_bytes) throw invalid('payload.url', 'URL too long.');
    let parsed;
    try {
      parsed = new URL(out.url);
    } catch {
      throw invalid('payload.url', 'Expected an absolute URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw invalid('payload.url', 'Expected an http(s) URL without credentials.');
    }
  }
  if (bytes(canonicalJson(out)) > LIMITS.payload_bytes) throw invalid('payload', 'Payload too large.');
  return Object.keys(out).length ? out : null;
}

// Resolve a server-absolute page route ("/", "/inbox/", "/a/b.html") to a
// discovered HTML file inside root. Returns the normalized route.
export function resolveTargetPage(root, page, field = 'target.page') {
  if (typeof page !== 'string' || page === '') throw invalid(field, 'Expected a page path.');
  if (bytes(page) > LIMITS.target_bytes) throw invalid(field, 'Page path too long.');
  if (!page.startsWith('/') || page.startsWith('//')) throw new IntentError(422, 'unsupported_target', 'Expected a server-absolute page path.', field);
  if (/[\\\0?#%]/.test(page) || /[\u0000-\u001f\u007f]/.test(page)) throw new IntentError(422, 'unsupported_target', 'Page path contains a disallowed character.', field);
  const segments = page.slice(1).split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '' && !last) throw new IntentError(422, 'unsupported_target', 'Empty path segment.', field);
    if (segment === '.' || segment === '..') throw new IntentError(422, 'unsupported_target', 'Dot segments are not allowed.', field);
    if (segment.startsWith('.') || EXCLUDED_SEGMENTS.has(segment)) throw new IntentError(422, 'unsupported_target', 'Private or excluded path.', field);
  }
  const lastSegment = segments[segments.length - 1];
  let relative;
  if (lastSegment === '') relative = [...segments.slice(0, -1), 'index.html'];
  else if (lastSegment.endsWith('.html')) relative = segments;
  else throw new IntentError(422, 'unsupported_target', 'Target must be a directory route ending in / or an .html page.', field);
  const realRoot = fs.realpathSync.native(root);
  const candidate = path.join(realRoot, ...relative);
  let real;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    throw new IntentError(404, 'target_not_found', 'Target page does not exist.', field);
  }
  if (!isPathInside(real, realRoot)) throw new IntentError(404, 'target_not_found', 'Target page does not exist.', field);
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new IntentError(404, 'target_not_found', 'Target page does not exist.', field);
  return { page, file: real };
}

function findIntent(state, id) {
  if (!isUuid(id)) throw new IntentError(404, 'intent_not_found', 'Intent not found.');
  const intent = state.intents.find((item) => item.intent_id === id);
  if (!intent) throw new IntentError(404, 'intent_not_found', 'Intent not found.');
  return intent;
}

function checkVersion(intent, version) {
  if (version === undefined) return;
  if (!Number.isInteger(version) || version < 1) throw invalid('version', 'Expected a positive integer.');
  if (version !== intent.version) throw new IntentError(409, 'version_conflict', 'The intent changed; reload before retrying.');
}

function touch(intent) {
  intent.version += 1;
  intent.updated_at = now();
}

// ---------- Browser (operator) operations ----------

export function validateCreate(root, body) {
  assertObject(body, 'body');
  assertKnownKeys(body, CREATE_KEYS);
  if (body.schema_version !== 1) throw invalid('schema_version', 'Unsupported schema version.');
  requestId(body.request_id);
  if (body.mode !== 'capture' && body.mode !== 'comment') throw invalid('mode', 'Expected "capture" or "comment".');
  const message = boundedString(body.operator_message, 'operator_message', LIMITS.operator_message_bytes, { required: true, nonBlank: true });
  let typeHint = null;
  if (body.type_hint !== undefined && body.type_hint !== null) {
    if (!TYPE_HINTS.includes(body.type_hint)) throw invalid('type_hint', 'Unknown type hint.');
    typeHint = body.type_hint;
  }
  let target = null;
  let observed = null;
  if (body.mode === 'capture') {
    if (body.target !== null && body.target !== undefined) throw invalid('target', 'Capture must have target null.');
  } else {
    assertObject(body.target, 'target');
    assertKnownKeys(body.target, new Set(['page']), 'target');
    const resolved = resolveTargetPage(root, body.target.page);
    target = { page: resolved.page };
    observed = {
      html_sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved.file)).digest('hex'),
      observed_at: now(),
    };
  }
  const payload = validatePayload(body.payload);
  return { request_id: body.request_id, mode: body.mode, type_hint: typeHint, operator_message: message, target, payload, observed };
}

export function createIntent(state, root, body, { principal = 'operator', channel = 'authenticated-browser' } = {}) {
  assertObject(body, 'body');
  // Idempotency check happens before target re-validation so a retry of an
  // accepted comment still replays even if the page changed since.
  const key = `${principal}:${body.request_id}`;
  const existing = isUuid(body.request_id) ? state.requests[key] : undefined;
  const bodyDigest = digest(body);
  if (existing) {
    if (existing.kind !== 'create' || existing.digest !== bodyDigest) {
      throw new IntentError(409, 'idempotency_conflict', 'This request_id was already used with different content.');
    }
    return { intent: findIntent(state, existing.intent_id), replayed: true };
  }
  const valid = validateCreate(root, body);
  const timestamp = now();
  const intent = {
    schema_version: 1,
    intent_id: crypto.randomUUID(),
    request_id: valid.request_id,
    mode: valid.mode,
    type_hint: valid.type_hint,
    operator_message: valid.operator_message,
    target: valid.target,
    observed: valid.observed,
    payload: valid.payload,
    provenance: { channel, principal_id: principal, received_at: timestamp },
    state: 'open',
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    messages: [],
    processing: { attempts: 0, claim: null },
    result: null,
  };
  state.intents.push(intent);
  state.requests[key] = { kind: 'create', intent_id: intent.intent_id, digest: bodyDigest };
  return { intent, replayed: false };
}

export function replyIntent(state, id, body, { principal = 'operator' } = {}) {
  assertObject(body, 'body');
  assertKnownKeys(body, REPLY_KEYS);
  requestId(body.request_id);
  const intent = findIntent(state, id);
  const key = `${principal}:${body.request_id}`;
  const bodyDigest = digest({ id, ...body });
  const existing = state.requests[key];
  if (existing) {
    if (existing.kind !== 'reply' || existing.digest !== bodyDigest) throw new IntentError(409, 'idempotency_conflict', 'This request_id was already used with different content.');
    return { intent, replayed: true };
  }
  const message = boundedString(body.operator_message, 'operator_message', LIMITS.operator_message_bytes, { required: true, nonBlank: true });
  checkVersion(intent, body.version);
  if (intent.state !== 'open' && intent.state !== 'needs-input') throw new IntentError(409, 'invalid_transition', `Cannot reply to an ${intent.state} intent; create a new request.`);
  const replies = intent.messages.filter((item) => item.author === 'operator').length;
  if (replies >= LIMITS.replies_per_intent) throw new IntentError(409, 'capacity_reached', 'Follow-up limit reached; create a new linked request.');
  intent.messages.push({ author: 'operator', kind: 'reply', text: message, request_id: body.request_id, principal_id: principal, at: now() });
  if (intent.state === 'needs-input') intent.state = 'open';
  touch(intent);
  state.requests[key] = { kind: 'reply', intent_id: intent.intent_id, digest: bodyDigest };
  return { intent, replayed: false };
}

export function operatorArchive(state, id, body, { principal = 'operator' } = {}) {
  assertObject(body, 'body');
  assertKnownKeys(body, ARCHIVE_KEYS);
  requestId(body.request_id);
  const intent = findIntent(state, id);
  const key = `${principal}:${body.request_id}`;
  const bodyDigest = digest({ id, ...body, kind: 'archive' });
  const existing = state.requests[key];
  if (existing) {
    if (existing.kind !== 'archive' || existing.digest !== bodyDigest) throw new IntentError(409, 'idempotency_conflict', 'This request_id was already used with different content.');
    return { intent, replayed: true };
  }
  checkVersion(intent, body.version);
  if (intent.state === 'archived') throw new IntentError(409, 'invalid_transition', 'Already archived.');
  if (intent.processing.claim) throw new IntentError(409, 'claim_conflict', 'An agent is working on this request; ask it to stop first.');
  intent.archive = { reason: intent.state === 'addressed' ? 'archived_by_operator' : 'cancelled', by: 'operator', at: now() };
  intent.state = 'archived';
  touch(intent);
  state.requests[key] = { kind: 'archive', intent_id: intent.intent_id, digest: bodyDigest };
  return { intent, replayed: false };
}

// ---------- Views ----------

export function statusLabel(intent) {
  if (intent.state === 'open') return intent.processing.claim ? 'Pending (processing)' : 'Pending';
  if (intent.state === 'needs-input') return 'Needs input';
  if (intent.state === 'addressed') return 'Addressed';
  return 'Archived';
}

// Browser-safe view: no claim token, consumer identity, or filesystem paths.
export function publicIntent(intent) {
  return {
    intent_id: intent.intent_id,
    request_id: intent.request_id,
    mode: intent.mode,
    type_hint: intent.type_hint,
    operator_message: intent.operator_message,
    target: intent.target,
    payload: intent.payload,
    state: intent.state,
    status: statusLabel(intent),
    version: intent.version,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
    messages: intent.messages.map(({ author, kind, text, at }) => ({ author, kind, text, at })),
    processing: { claimed: Boolean(intent.processing.claim), attempts: intent.processing.attempts },
    result: intent.result,
    archive: intent.archive ?? null,
  };
}

function encodeCursor(view, intent) {
  return Buffer.from(JSON.stringify({ v: view, c: intent.created_at, i: intent.intent_id })).toString('base64url');
}

function decodeCursor(view, cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed.v !== view || typeof parsed.c !== 'string' || !isUuid(parsed.i)) throw new Error('bad');
    return parsed;
  } catch {
    throw invalid('cursor', 'Invalid cursor for this view.');
  }
}

const sortKey = (item) => `${item.created_at}\u0000${item.intent_id}`;

export function listIntents(state, { view = 'open', limit = 50, cursor = null } = {}) {
  if (!['open', 'history', 'all'].includes(view)) throw invalid('view', 'Expected open or history.');
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, LIMITS.list_max) : 50;
  const members = state.intents.filter((item) => view === 'all'
    || (view === 'open' ? ['open', 'needs-input'].includes(item.state) : ['addressed', 'archived'].includes(item.state)));
  // open: oldest first (work queue); history: newest first.
  members.sort((a, b) => (view === 'history' ? sortKey(b).localeCompare(sortKey(a)) : sortKey(a).localeCompare(sortKey(b))));
  let start = 0;
  if (cursor) {
    const at = decodeCursor(view, cursor);
    const key = `${at.c}\u0000${at.i}`;
    start = members.findIndex((item) => (view === 'history' ? sortKey(item) < key : sortKey(item) > key));
    if (start === -1) start = members.length;
  }
  const items = members.slice(start, start + max);
  const next = start + max < members.length ? encodeCursor(view, items[items.length - 1]) : null;
  return { items, next_cursor: next };
}

// ---------- Consumer (agent) operations ----------

function requireClaim(intent, token) {
  const claim = intent.processing.claim;
  if (!claim) throw new IntentError(409, 'claim_required', 'Claim the intent first.');
  if (typeof token !== 'string' || !timingSafeEqualString(claim.token_sha256, sha256(token))) {
    throw new IntentError(409, 'claim_conflict', 'Claim token does not match the current claim.');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function claimIntent(state, id, { consumer = 'agent' } = {}) {
  let intent;
  if (id) {
    intent = findIntent(state, id);
  } else {
    intent = listIntents(state, { view: 'open', limit: LIMITS.list_max }).items.find((item) => item.state === 'open' && !item.processing.claim);
    if (!intent) throw new IntentError(404, 'no_eligible_intent', 'No open, unclaimed intents.');
  }
  if (intent.state !== 'open') throw new IntentError(409, 'invalid_transition', `Cannot claim an intent in state ${intent.state}.`);
  if (intent.processing.claim) throw new IntentError(409, 'claim_conflict', 'Intent is already claimed.');
  const token = crypto.randomBytes(16).toString('hex');
  intent.processing.claim = { consumer: String(consumer).slice(0, 64), token_sha256: sha256(token), claimed_at: now() };
  intent.processing.attempts += 1;
  touch(intent);
  return { intent, token };
}

export function releaseIntent(state, id, token) {
  const intent = findIntent(state, id);
  requireClaim(intent, token);
  intent.processing.claim = null;
  touch(intent);
  return { intent };
}

export function askIntent(state, id, token, question) {
  const intent = findIntent(state, id);
  if (intent.state !== 'open') throw new IntentError(409, 'invalid_transition', `Cannot ask on an intent in state ${intent.state}.`);
  requireClaim(intent, token);
  const text = boundedString(question, 'question', LIMITS.question_bytes, { required: true, nonBlank: true });
  intent.messages.push({ author: 'agent', kind: 'question', text, at: now() });
  intent.state = 'needs-input';
  intent.processing.claim = null;
  touch(intent);
  return { intent };
}

function verifyCommit(root, commit) {
  if (!COMMIT_RE.test(commit)) throw invalid('commit', 'Expected a hex commit id.');
  if (!fs.existsSync(path.join(root, '.git'))) return commit;
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { encoding: 'utf8' });
  if (result.status !== 0) throw invalid('commit', 'Commit does not exist in the knowledge repo.');
  return result.stdout.trim();
}

export function resolveIntent(state, root, id, token, { outcome, summary, page, commit } = {}) {
  const intent = findIntent(state, id);
  if (intent.state !== 'open') throw new IntentError(409, 'invalid_transition', `Cannot resolve an intent in state ${intent.state}.`);
  requireClaim(intent, token);
  if (!OUTCOMES.includes(outcome)) throw invalid('outcome', `Expected one of ${OUTCOMES.join(', ')}.`);
  const text = boundedString(summary, 'summary', LIMITS.summary_bytes, { required: true, nonBlank: true });
  let fullCommit = null;
  if (commit !== undefined && commit !== null && commit !== '') fullCommit = verifyCommit(root, String(commit));
  if (outcome === 'changed' && !fullCommit) throw invalid('commit', 'A changed outcome requires a commit id.');
  const refs = [];
  if (page !== undefined && page !== null && page !== '') refs.push({ page: resolveTargetPage(root, page, 'page').page });
  intent.result = { outcome, summary: text, refs, commit: fullCommit, addressed_at: now() };
  intent.state = 'addressed';
  intent.processing.claim = null;
  touch(intent);
  return { intent };
}

export function consumerArchive(state, id, token, reason = 'archived_by_agent') {
  const intent = findIntent(state, id);
  if (intent.state === 'archived') throw new IntentError(409, 'invalid_transition', 'Already archived.');
  if (intent.state !== 'addressed') {
    // Agents may not silently drop operator work; declining is an explicit
    // addressed outcome. Archiving an unaddressed intent needs the claim.
    requireClaim(intent, token);
  } else if (intent.processing.claim) {
    requireClaim(intent, token);
  }
  intent.archive = { reason: String(reason).slice(0, 200), by: 'agent', at: now() };
  intent.state = 'archived';
  intent.processing.claim = null;
  touch(intent);
  return { intent };
}

export function summarize(state) {
  const counts = Object.fromEntries(STATES.map((name) => [name, 0]));
  let claimed = 0;
  for (const item of state.intents) {
    counts[item.state] += 1;
    if (item.processing.claim) claimed += 1;
  }
  const oldest = listIntents(state, { view: 'open', limit: 1 }).items[0];
  return { counts, claimed, oldest_open: oldest ? { intent_id: oldest.intent_id, created_at: oldest.created_at, state: oldest.state } : null };
}
