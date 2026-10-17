// Private, service-owned intent state for one knowledge repo.
//
// MVP storage: one JSON snapshot per repo under
// ${XDG_STATE_HOME:-~/.local/state}/cockpit-kit/<repo-hash>/intents.json,
// written atomically (exclusive temp file + rename) with mode 0600. Every
// mutation takes a short-lived directory lock, re-reads the snapshot,
// applies the change, and installs the next snapshot, so the HTTP service
// and the consumer CLI can share the file without a daemon socket.
//
// Deferred hardening (see docs/design/operator-comments-and-capture.md):
// fsync of file and directory, durability hold, stale-lock proof beyond a
// timeout, repo registration UUIDs instead of path hashes, capacity
// accounting, retention/tombstones.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, isPathInside } from '../paths.mjs';

export const STATE_SCHEMA_VERSION = 1;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

export class StoreError extends Error {
  constructor(message, code = 'store_unavailable') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function stateBaseDir(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== ''
    ? expandHome(env.XDG_STATE_HOME, env)
    : path.join(expandHome('~', env), '.local', 'state');
  return path.join(path.resolve(base), 'cockpit-kit');
}

export function repoKey(root) {
  const real = fs.realpathSync.native(path.resolve(root));
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export function stateDirFor(root, env = process.env) {
  return path.join(stateBaseDir(env), repoKey(root));
}

function emptyState(root) {
  return { schema_version: STATE_SCHEMA_VERSION, root, intents: [], requests: {} };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class IntentStore {
  constructor({ root, env = process.env, stateDir } = {}) {
    this.root = fs.realpathSync.native(path.resolve(root));
    this.stateDir = path.resolve(stateDir ?? stateDirFor(this.root, env));
    this.file = path.join(this.stateDir, 'intents.json');
    this.lockDir = path.join(this.stateDir, 'intents.lock');
    if (isPathInside(this.stateDir, this.root) || isPathInside(this.root, this.stateDir)) {
      throw new StoreError('Intent state directory must be outside the served Cockpit root', 'unsafe_state_dir');
    }
  }

  ensureDir() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StoreError('Intent state directory is not a real directory', 'unsafe_state_dir');
    fs.chmodSync(this.stateDir, 0o700);
  }

  read() {
    let stat;
    try {
      stat = fs.lstatSync(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState(this.root);
      throw new StoreError('Intent state is unreadable');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new StoreError('Intent state is not a regular file', 'unsafe_state_file');
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new StoreError('Intent state is not valid JSON', 'invalid_state');
    }
    if (!state || state.schema_version !== STATE_SCHEMA_VERSION || !Array.isArray(state.intents) || typeof state.requests !== 'object') {
      throw new StoreError('Intent state has an unsupported schema', 'invalid_state');
    }
    if (state.root !== this.root) throw new StoreError('Intent state belongs to a different Cockpit root', 'invalid_state');
    return state;
  }

  write(state) {
    this.ensureDir();
    const temp = path.join(this.stateDir, `.intents.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  lock() {
    this.ensureDir();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir, { mode: 0o700 });
        fs.writeFileSync(path.join(this.lockDir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600 });
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw new StoreError('Cannot take intent state lock');
      }
      try {
        // MVP: a lock older than LOCK_STALE_MS is presumed abandoned. Locks are
        // held only for one read-modify-write, never across agent work.
        if (Date.now() - fs.statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(this.lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new StoreError('Intent state is locked by another writer', 'store_busy');
      sleep(25);
    }
  }

  unlock() {
    fs.rmSync(this.lockDir, { recursive: true, force: true });
  }

  // Run fn(state) under the lock. fn mutates state in place and returns a
  // value; if it throws, nothing is written.
  mutate(fn) {
    this.lock();
    try {
      const state = this.read();
      const result = fn(state);
      this.write(state);
      return result;
    } finally {
      this.unlock();
    }
  }
}
