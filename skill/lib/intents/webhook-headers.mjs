// Optional extra headers (e.g. an auth key) for the wake webhook.
// File format: one `Header-Name: value` per line; blank lines and lines
// starting with `#` are ignored. The file must be a regular, owner-only
// file (no group/world permission bits). Values are secrets: they are never
// logged or echoed in error messages (errors cite line numbers and names).
import fs from 'node:fs';

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// eslint-disable-next-line no-control-regex
const BAD_VALUE_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const RESERVED = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'proxy-connection']);
const MAX_BYTES = 16384;
const MAX_HEADERS = 32;

export class WebhookHeadersError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookHeadersError';
  }
}

export function parseWebhookHeaders(text, source = 'webhook headers file') {
  const headers = {};
  const seen = new Set();
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, index) => {
    const at = `${source} line ${index + 1}`;
    if (line.includes('\r')) throw new WebhookHeadersError(`${at}: carriage returns are not allowed (use LF line endings)`);
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new WebhookHeadersError(`${at}: expected "Header-Name: value"`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!TOKEN_RE.test(name)) throw new WebhookHeadersError(`${at}: invalid header name`);
    const lower = name.toLowerCase();
    if (RESERVED.has(lower)) throw new WebhookHeadersError(`${at}: header ${name} is managed by the service and cannot be set`);
    if (seen.has(lower)) throw new WebhookHeadersError(`${at}: duplicate header ${name}`);
    if (value === '') throw new WebhookHeadersError(`${at}: header ${name} has an empty value`);
    if (BAD_VALUE_RE.test(value)) throw new WebhookHeadersError(`${at}: header ${name} value contains control characters`);
    seen.add(lower);
    headers[name] = value;
  });
  if (Object.keys(headers).length > MAX_HEADERS) throw new WebhookHeadersError(`${source}: more than ${MAX_HEADERS} headers`);
  return headers;
}

export function loadWebhookHeaders(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new WebhookHeadersError(`webhook headers file not found or unreadable: ${file}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new WebhookHeadersError(`webhook headers file must be a regular file (not a symlink): ${file}`);
  if ((stat.mode & 0o077) !== 0) throw new WebhookHeadersError(`webhook headers file must not be accessible by group or others (chmod 600): ${file}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new WebhookHeadersError(`webhook headers file must be owned by the service user: ${file}`);
  if (stat.size > MAX_BYTES) throw new WebhookHeadersError(`webhook headers file is larger than ${MAX_BYTES} bytes: ${file}`);
  return parseWebhookHeaders(fs.readFileSync(file, 'utf8'), 'webhook headers file');
}
