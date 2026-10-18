#!/usr/bin/env node
// Advisory write lock for a Cockpit root shared by several agents.
// See README "Multi-agent write lock" and skill/SKILL.md "Write Lock".
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ArgumentError, resolveRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import {
  DEFAULT_TTL_MS, EXIT_BUSY, GITIGNORE_PATTERN, LockError, acquireLock, describeLock, lockIgnoredByGit, lockStatus,
  parseDuration, releaseLock, renewLock, validateHolder,
} from '../lib/lock.mjs';

function usage() {
  return `Usage: node scripts/lock.mjs <command> [options]

Commands:
  status                          Show who holds the cockpit write lock
  acquire --holder <name> [--purpose <text>] [--ttl 10m] [--wait 0s] [--pid <pid>]
                                  Take the lock (same holder renews it)
  release --holder <name>         Release the lock you hold
  release --force                 Operator override: release whoever holds it
  run --holder <name> [--purpose <text>] [--ttl 10m] [--wait 0s] -- <command...>
                                  Acquire, run the command, release (even on failure).
                                  Exits with the command's status. The child sees
                                  COCKPIT_LOCK_HOLDER=<name>, so kit commands inside
                                  it (search-index.mjs) proceed under this lock.

Options:
  --root <path>      Cockpit root (default: configured root)
  --holder <name>    Lock holder label (default: $COCKPIT_LOCK_HOLDER)
  --purpose <text>   Short note shown to other agents
  --ttl <duration>   Lock lifetime, e.g. 90s, 10m, 1h (default 10m). \`run\`
                     renews it while the command is running.
  --wait <duration>  How long to wait for a busy lock (default 0s: fail now)
  --pid <pid>        acquire only: bind the lock to a long-lived process on
                     this host; it can be taken over once that process exits
  --json             Machine-readable output
  --help             Show this help

A lock past its TTL, or a run/--pid lock whose process is gone on the same
host, is taken over automatically with a message. Exit status: 0 ok,
${EXIT_BUSY} lock busy (retry later), 1 other errors.
`;
}

const VALUE_FLAGS = new Set(['--root', '--cockpit-root', '--holder', '--purpose', '--ttl', '--wait', '--pid']);

export function parseArgs(argv) {
  const options = { positional: [], rootArgs: [], command: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.command = argv.slice(i + 1);
      break;
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.has(name)) throw new ArgumentError(`Unknown option: ${arg}`);
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value === '--') throw new ArgumentError(`${name} requires a value`);
        i += 1;
      }
      if (name === '--root' || name === '--cockpit-root') options.rootArgs.push(name, value);
      else options[name.slice(2)] = value;
    } else options.positional.push(arg);
  }
  return options;
}

function holderFrom(options, env) {
  const holder = options.holder ?? env.COCKPIT_LOCK_HOLDER;
  if (!holder) throw new ArgumentError('--holder <name> is required (or set COCKPIT_LOCK_HOLDER)');
  return validateHolder(holder);
}

function durations(options) {
  return {
    ttlMs: options.ttl === undefined ? DEFAULT_TTL_MS : parseDuration(options.ttl, '--ttl'),
    waitMs: options.wait === undefined ? 0 : parseDuration(options.wait, '--wait'),
  };
}

function emit(out, options, payload, text) {
  out.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);
}

function warnIfTracked(root, stderr) {
  if (lockIgnoredByGit(root) === false) {
    stderr.write(`Warning: .cockpit/lock is not gitignored in ${root}. Add "${GITIGNORE_PATTERN}" to its .gitignore so the lock is never committed.\n`);
  }
}

function reportAcquire(result, holder, stderr) {
  if (result.takeover) stderr.write(`Took over stale cockpit write lock from ${result.takeover.previous.holder} (${result.takeover.reason}).\n`);
  return result.renewed
    ? `Renewed cockpit write lock for ${holder} (expires ${result.lock.expires_at}).`
    : `Acquired cockpit write lock for ${holder} (expires ${result.lock.expires_at}).`;
}

function publicRecord(lock) {
  if (!lock) return null;
  const { raw, token, ...rest } = lock;
  return rest;
}

async function runCommand(root, options, { env, stdout, stderr }) {
  const holder = holderFrom(options, env);
  if (!options.command || options.command.length === 0) throw new ArgumentError('run requires a command after --, e.g. lock.mjs run --holder me -- git status');
  const { ttlMs, waitMs } = durations(options);
  const result = await acquireLock(root, { holder, purpose: options.purpose, ttlMs, waitMs, pidBound: true });
  warnIfTracked(root, stderr);
  stderr.write(`${reportAcquire(result, holder, stderr)}\n`);
  // If this holder already had the lock (an outer acquire or run), leave it in
  // place afterwards; only release what this invocation created.
  const ownsLock = !result.renewed;
  const token = result.lock.token;
  const heartbeat = setInterval(() => {
    try {
      if (!renewLock(root, { holder, ttlMs, token: ownsLock ? token : undefined })) stderr.write(`Warning: lost the cockpit write lock (${describeLock(lockStatus(root).lock)}).\n`);
    } catch (error) {
      stderr.write(`Warning: could not renew the cockpit write lock: ${error.message}\n`);
    }
  }, Math.max(200, Math.floor(ttlMs / 3)));
  heartbeat.unref();

  const [file, ...args] = options.command;
  const child = spawn(file, args, { stdio: 'inherit', env: { ...env, COCKPIT_LOCK_HOLDER: holder } });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (signal) => { child.kill(signal); };
  for (const signal of signals) process.on(signal, forward);
  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr.write(`lock run: could not start ${file}: ${error.message}\n`);
      resolve(error.code === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? 128 + (signal ? ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1) : 1));
    });
  });
  clearInterval(heartbeat);
  for (const signal of signals) process.off(signal, forward);
  if (ownsLock) {
    try {
      const released = releaseLock(root, { holder, token });
      if (released.released) stderr.write(`Released cockpit write lock for ${holder}.\n`);
      else if (released.reason !== 'not_locked') stderr.write(`Warning: cockpit write lock changed while running; left it alone (${describeLock(released.lock)}).\n`);
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== 'not_holder') throw error;
      stderr.write(`Warning: cockpit write lock was taken over while running; left it alone (${describeLock(error.lock)}).\n`);
    }
  }
  return exitCode;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseArgs(argv);
  const sub = options.positional[0];
  if (options.help || !sub) {
    (options.help ? stdout : stderr).write(usage());
    return options.help ? 0 : 1;
  }
  if (options.positional.length > 1) throw new ArgumentError(`Unexpected argument: ${options.positional[1]}${sub === 'run' ? ' (put the command after --)' : ''}`);
  if (options.command && sub !== 'run') throw new ArgumentError(`${sub} does not take a command after --`);
  const { root } = resolveRoot({ argv: options.rootArgs, env, forWrite: true, stderr });

  if (sub === 'status') {
    const status = lockStatus(root);
    const ignored = lockIgnoredByGit(root);
    const text = status.locked
      ? `Cockpit write lock: ${describeLock(status.lock)}${status.stale ? `\nStale (${status.stale}); the next acquire will take it over.` : ''}`
      : 'Cockpit write lock: unlocked';
    emit(stdout, options, { ...status, gitignored: ignored }, text);
    if (ignored === false && !options.json) warnIfTracked(root, stderr);
    return 0;
  }
  if (sub === 'acquire') {
    const holder = holderFrom(options, env);
    const { ttlMs, waitMs } = durations(options);
    let pid;
    if (options.pid !== undefined) {
      pid = Number.parseInt(options.pid, 10);
      if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== String(options.pid)) throw new ArgumentError('--pid must be a positive integer');
    }
    const result = await acquireLock(root, { holder, purpose: options.purpose, ttlMs, waitMs, pidBound: pid !== undefined, ...(pid ? { pid } : {}) });
    warnIfTracked(root, stderr);
    const text = reportAcquire(result, holder, stderr);
    emit(stdout, options, { acquired: true, renewed: Boolean(result.renewed), takeover: result.takeover ?? null, lock: publicRecord(result.lock) }, text);
    return 0;
  }
  if (sub === 'release') {
    const holder = options.force ? (options.holder ?? env.COCKPIT_LOCK_HOLDER) : holderFrom(options, env);
    const result = releaseLock(root, { holder, force: Boolean(options.force) });
    const text = result.reason === 'not_locked' ? 'Cockpit write lock: not locked; nothing to release.'
      : result.released ? `Released cockpit write lock (was ${describeLock(result.lock)}).`
        : 'Cockpit write lock changed during release; left it in place.';
    emit(stdout, options, result, text);
    return result.released || result.reason === 'not_locked' ? 0 : 1;
  }
  if (sub === 'run') return runCommand(root, options, { env, stdout, stderr });
  throw new ArgumentError(`Unknown command: ${sub}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertNode20();
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof LockError && error.code === 'lock_busy' ? EXIT_BUSY : 1;
  }
}
