// Exact browser-origin allowlist parsing for the write API.
// Each configured origin is scheme + host + optional port, nothing else.
// Wildcards, lists in one value, paths, queries, fragments, and userinfo are
// rejected at startup. Request Origin headers are then compared by exact
// string equality against the normalized set (no suffix or pattern matching).
import { ArgumentError } from '../config.mjs';

export function normalizeOrigin(value, source = '--origin') {
  const fail = (why) => new ArgumentError(`${source} ${JSON.stringify(String(value))} is not an exact origin (${why}); expected e.g. https://cockpit.example or http://127.0.0.1:18765`);
  if (typeof value !== 'string' || value === '') throw fail('empty');
  if (value.trim() !== value || /\s/.test(value)) throw fail('contains whitespace');
  if (value.includes('*')) throw fail('wildcards are not supported');
  if (value.includes(',')) throw fail('one origin per value; repeat the flag for more');
  const scheme = /^(https?):\/\//i.exec(value);
  if (!scheme) throw fail('scheme must be http:// or https://');
  let authority = value.slice(scheme[0].length);
  if (authority.endsWith('/')) authority = authority.slice(0, -1);
  if (authority === '' || /[/?#@\\]/.test(authority)) throw fail('no path, query, fragment, or credentials allowed');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail('malformed');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw fail('malformed');
  return parsed.origin;
}

// Normalize and de-duplicate a list of origins; throws on the first bad one.
export function normalizeOrigins(values, source = '--origin') {
  return [...new Set((values ?? []).map((value) => normalizeOrigin(value, source)))];
}
