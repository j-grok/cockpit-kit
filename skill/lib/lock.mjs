// Advisory, cockpit-scoped write lock.
//
// Several agents (local or over SSH) may edit the same knowledge repo. The
// lock serializes "edit -> lint -> index -> commit -> push" operations so they
// do not collide on .cockpit/nav.toml, the search index, or the git index.
//
// The lock is a JSON file at <root>/.cockpit/lock. It is created atomically:
// the record is written to a private temp file and then hard-linked into
// place, which fails with EEXIST if another holder got there first, so a
// reader never sees a half-written lock. It is advisory: tools that honor it
// (lock.mjs, search-index.mjs) cooperate; nothing stops a process that ignores
// it. `.cockpit/` is never served (except the search index), and the lock
// files should be gitignored (`/.cockpit/lock*`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOCK_FILE = 'lock';
export const LOCK_VERSION = 1;
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const GITIGNORE_PATTERN = '/.cockpit/lock*';
// Exit code for "lock is busy" (BSD EX_TEMPFAIL): retry later.
export const EXIT_BUSY = 75;
const GUARD_STALE_MS = 30 * 1000;
const HOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,63}$/;

export class LockError extends Error {
  constructor(message, { code = 'lock_error', lock = null } = {}) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.lock = lock;
  }
}

export class LockBusyError extends LockError {
  constructor(message, lock) {
    super(message, { code: 'lock_busy', lock });
    this.name = 'LockBusyError';
  }
}

export function lockPath(root) {
  return path.join(root, '.cockpit', LOCK_FILE);
}

export function parseDuration(value, flag = 'duration') {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? '').trim());
  if (!match) throw new LockError(`${flag} must be a duration like 30s, 10m, or 1h (got ${JSON.stringify(value)})`, { code: 'invalid_argument' });
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? 's'];
  return Math.round(Number(match[1]) * scale);
}

export function validateHolder(holder) {
  if (typeof holder !== 'string' || !HOLDER_RE.test(holder)) {
    throw new LockError('--holder must be 1-64 characters: letters, digits, and . _ @ : - (starting with a letter or digit)', { code: 'invalid_argument' });
  }
  return holder;
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runtime(options = {}) {
  return {
    now: options.now ?? (() => Date.now()),
    host: options.host ?? os.hostname(),
    pid: options.pid ?? process.pid,
    pidAlive: options.pidAlive ?? defaultPidAlive,
  };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function readLock(root) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed, raw };
  } catch { /* fall through */ }
  // Unparseable lock (e.g. hand-edited): treat as held by an unknown holder
  // with no expiry information; only --force release or takeover after the
  // file's mtime + default TTL clears it.
  let mtime = 0;
  try { mtime = fs.statSync(lockPath(root)).mtimeMs; } catch { /* ignore */ }
  return { holder: '(unreadable lock)', purpose: null, pid: null, host: null, acquired_at: null, expires_at: new Date(mtime + DEFAULT_TTL_MS).toISOString(), raw, corrupt: true };
}

// Why a lock may be taken over, or null if it is live.
export function staleReason(lock, options = {}) {
  const rt = runtime(options);
  if (!lock) return null;
  const expires = Date.parse(lock.expires_at);
  if (!Number.isFinite(expires) || expires <= rt.now()) return `expired at ${lock.expires_at ?? '(unknown)'}`;
  if (lock.pid_bound && lock.host === rt.host && !rt.pidAlive(lock.pid)) return `process ${lock.pid} on ${lock.host} is no longer running`;
  return null;
}

export function describeLock(lock) {
  if (!lock) return 'unlocked';
  const purpose = lock.purpose ? ` for "${lock.purpose}"` : '';
  const where = lock.host ? ` (pid ${lock.pid ?? '?'} on ${lock.host})` : '';
  return `held by ${lock.holder}${purpose}${where} since ${lock.acquired_at ?? '(unknown)'}, expires ${lock.expires_at ?? '(unknown)'}`;
}

function publicLock(lock) {
  if (!lock) return null;
  const { raw, token, ...rest } = lock;
  return rest;
}

function writeTemp(root, record) {
  const dir = path.join(root, '.cockpit');
  const temp = path.join(dir, `${LOCK_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  return temp;
}

// Atomically create the lock file; returns false if a lock already exists.
function createExclusive(root, record) {
  const temp = writeTemp(root, record);
  try {
    fs.linkSync(temp, lockPath(root));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Short-lived mutex around read-check-unlink so two agents taking over the
// same stale lock (or a release racing a takeover) cannot delete a lock that
// was freshly acquired by someone else.
function withGuard(root, fn) {
  const guard = path.join(root, '.cockpit', `${LOCK_FILE}.guard`);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      fs.mkdirSync(guard);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.statSync(guard, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > GUARD_STALE_MS) fs.rmSync(guard, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.rmSync(guard, { recursive: true, force: true });
    }
  }
  throw new LockError(`Timed out waiting for ${guard}; remove it if no lock command is running.`);
}

// Remove the lock only if it is still exactly the one we inspected.
function unlinkIfUnchanged(root, expectedRaw, options) {
  return withGuard(root, () => {
    let current;
    try {
      current = fs.readFileSync(lockPath(root), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (current !== expectedRaw) return false;
    fs.unlinkSync(lockPath(root));
    return true;
  });
}

function newRecord({ holder, purpose, ttlMs, pidBound, token }, rt) {
  const now = rt.now();
  return {
    version: LOCK_VERSION,
    holder,
    purpose: purpose ?? null,
    pid: rt.pid,
    pid_bound: Boolean(pidBound),
    host: rt.host,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    token: token ?? crypto.randomBytes(12).toString('hex'),
  };
}

// One non-blocking attempt. Returns { acquired, lock, renewed, takeover } or
// { acquired: false, lock } when someone else holds a live lock.
export function tryAcquire(root, { holder, purpose, ttlMs = DEFAULT_TTL_MS, pidBound = false, ...options } = {}) {
  validateHolder(holder);
  const rt = runtime(options);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const record = newRecord({ holder, purpose, ttlMs, pidBound }, rt);
    if (createExclusive(root, record)) return { acquired: true, lock: record };
    const existing = readLock(root);
    if (!existing) continue; // released between our attempt and read; retry
    if (existing.holder === holder && !existing.corrupt) {
      // Re-entrant: same holder renews instead of deadlocking on itself.
      const renewed = renewLock(root, { holder, ttlMs, purpose, ...options });
      if (renewed) return { acquired: true, lock: renewed, renewed: true };
      continue;
    }
    const reason = staleReason(existing, rt);
    if (!reason) return { acquired: false, lock: existing };
    if (unlinkIfUnchanged(root, existing.raw, options)) {
      const fresh = newRecord({ holder, purpose, ttlMs, pidBound }, rt);
      if (createExclusive(root, fresh)) return { acquired: true, lock: fresh, takeover: { previous: publicLock(existing), reason } };
    }
  }
  const lock = readLock(root);
  return { acquired: false, lock };
}

export async function acquireLock(root, { waitMs = 0, pollMs = 250, ...options } = {}) {
  const rt = runtime(options);
  const deadline = rt.now() + waitMs;
  for (;;) {
    const result = tryAcquire(root, options);
    if (result.acquired) return result;
    if (rt.now() >= deadline) {
      throw new LockBusyError(`Cockpit write lock is ${describeLock(result.lock)}.${waitMs ? ` Gave up after waiting ${Math.round(waitMs / 1000)}s.` : ''} Retry later, pass --wait, or ask the holder to release it.`, publicLock(result.lock));
    }
    await sleep(Math.max(10, Math.min(pollMs, deadline - rt.now())));
  }
}

// Extend the expiry of a lock we hold. Returns the new record, or null if the
// lock is gone or now belongs to someone else.
export function renewLock(root, { holder, ttlMs = DEFAULT_TTL_MS, token, purpose, ...options } = {}) {
  const rt = runtime(options);
  return withGuard(root, () => {
    const current = readLock(root);
    if (!current || current.corrupt || current.holder !== holder) return null;
    if (token && current.token !== token) return null;
    const { raw, ...base } = current;
    const next = { ...base, purpose: purpose ?? current.purpose ?? null, expires_at: new Date(rt.now() + ttlMs).toISOString() };
    const temp = writeTemp(root, next);
    fs.renameSync(temp, lockPath(root));
    return next;
  });
}

export function releaseLock(root, { holder, force = false, token, ...options } = {}) {
  const current = readLock(root);
  if (!current) return { released: false, reason: 'not_locked' };
  if (!force) {
    validateHolder(holder);
    if (current.holder !== holder) {
      throw new LockError(`Refusing to release: cockpit write lock is ${describeLock(current)}, not by ${holder}. Operators can use --force.`, { code: 'not_holder', lock: publicLock(current) });
    }
    if (token && current.token !== token) return { released: false, reason: 'replaced', lock: publicLock(current) };
  }
  const released = unlinkIfUnchanged(root, current.raw, options);
  return { released, reason: released ? 'released' : 'changed', lock: publicLock(current) };
}

export function lockStatus(root, options = {}) {
  const lock = readLock(root);
  if (!lock) return { locked: false, lock: null, stale: null, path: lockPath(root) };
  return { locked: true, lock: publicLock(lock), stale: staleReason(lock, options), path: lockPath(root) };
}

// Gate for kit commands that mutate shared cockpit state. With no lock (or a
// stale one) behavior is unchanged. If another holder has a live lock, wait up
// to waitMs and then throw LockBusyError. A caller holding the lock passes its
// name via --holder or COCKPIT_LOCK_HOLDER (set automatically by `lock run`).
export async function assertWriteAllowed(root, { holder, waitMs = 10_000, pollMs = 250, stderr, ...options } = {}) {
  const rt = runtime(options);
  const deadline = rt.now() + waitMs;
  let announced = false;
  for (;;) {
    const lock = readLock(root);
    if (!lock) return { lock: null };
    if (holder && lock.holder === holder) return { lock: publicLock(lock), own: true };
    const reason = staleReason(lock, rt);
    if (reason) {
      stderr?.write(`Warning: ignoring stale cockpit write lock (${describeLock(lock)}; ${reason}).\n`);
      return { lock: publicLock(lock), stale: reason };
    }
    if (rt.now() >= deadline) {
      throw new LockBusyError(`Cockpit write lock is ${describeLock(lock)}. Wait for it, or run this under your own lock: lock.mjs run --holder <name> -- <command> (or pass --holder <name> if you already hold it).`, publicLock(lock));
    }
    if (!announced) {
      stderr?.write(`Cockpit write lock is ${describeLock(lock)}; waiting up to ${Math.round(waitMs / 1000)}s...\n`);
      announced = true;
    }
    await sleep(Math.max(10, Math.min(pollMs, deadline - rt.now())));
  }
}

// Best-effort check that the lock files are ignored by the root's git repo.
// Returns true/false, or null when the root is not a git work tree.
export function lockIgnoredByGit(root) {
  const probe = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', path.join('.cockpit', LOCK_FILE)], { encoding: 'utf8' });
  if (probe.error) return null;
  if (probe.status === 0) return true;
  if (probe.status === 1) return false;
  return null;
}
