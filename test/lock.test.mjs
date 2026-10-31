import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  EXIT_BUSY, LockBusyError, acquireLock, assertWriteAllowed, lockPath, lockStatus, parseDuration, readLock, releaseLock, tryAcquire,
} from '../skill/lib/lock.mjs';
import { createServeServer } from '../skill/scripts/serve.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const skillRoot = path.join(repoRoot, 'skill');
const lockScript = path.join(skillRoot, 'scripts', 'lock.mjs');
const indexScript = path.join(skillRoot, 'scripts', 'search-index.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-lock-root-'));
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  return root;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-lock-home-')), ...extra };
  delete env.COCKPIT_HOME;
  delete env.XDG_CONFIG_HOME;
  if (!Object.hasOwn(extra, 'COCKPIT_LOCK_HOLDER')) delete env.COCKPIT_LOCK_HOLDER;
  return env;
}

function lockCli(root, args, env = cleanEnv()) {
  return spawnSync(process.execPath, [lockScript, ...args.slice(0, 1), '--root', root, ...args.slice(1)], { env, encoding: 'utf8' });
}

function lockCliAsync(root, args, env = cleanEnv()) {
  const child = spawn(process.execPath, [lockScript, ...args.slice(0, 1), '--root', root, ...args.slice(1)], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return once(child, 'close').then(([status]) => ({ status, stdout, stderr }));
}

function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(result.stdout);
}

test('parseDuration accepts ms/s/m/h and bare seconds', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2'), 2000);
  assert.throws(() => parseDuration('soon'), /duration like/);
});

test('acquire is atomic: exactly one of many concurrent acquirers wins', async () => {
  const root = makeRoot();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => lockCliAsync(root, ['acquire', '--holder', `agent-${i}`, '--json'])));
  const winners = results.filter((result) => result.status === 0);
  assert.equal(winners.length, 1, results.map((r) => r.stderr).join('\n'));
  for (const loser of results.filter((result) => result.status !== 0)) {
    assert.equal(loser.status, EXIT_BUSY);
    assert.match(loser.stderr, /Cockpit write lock is held by agent-\d/);
  }
  const winner = JSON.parse(winners[0].stdout);
  const onDisk = readLock(root);
  assert.equal(onDisk.holder, winner.lock.holder);
  for (const key of ['holder', 'purpose', 'pid', 'host', 'acquired_at', 'expires_at']) assert.ok(Object.hasOwn(onDisk, key), key);
  assert.equal(onDisk.host, os.hostname());
  // No temp or guard files are left behind.
  assert.deepEqual(fs.readdirSync(path.join(root, '.cockpit')).filter((name) => name.startsWith('lock')), ['lock']);
});

test('contention: a second holder is refused with a clear message; same holder renews', async () => {
  const root = makeRoot();
  const first = lockCli(root, ['acquire', '--holder', 'argus', '--purpose', 'render inbox']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Acquired cockpit write lock for argus/);

  const second = lockCli(root, ['acquire', '--holder', 'hermes']);
  assert.equal(second.status, EXIT_BUSY);
  assert.match(second.stderr, /held by argus for "render inbox"/);
  assert.equal(readLock(root).holder, 'argus');

  const again = lockCli(root, ['acquire', '--holder', 'argus', '--ttl', '1h']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Renewed cockpit write lock for argus/);
  assert.ok(Date.parse(readLock(root).expires_at) > Date.now() + 50 * 60_000);

  const status = lockCli(root, ['status', '--json']);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.locked, true);
  assert.equal(payload.lock.holder, 'argus');
  assert.equal(payload.stale, null);
  assert.equal(Object.hasOwn(payload.lock, 'token'), false);
  assert.match(lockCli(root, ['status']).stdout, /Cockpit write lock: held by argus/);
});

test('wait: a waiter times out while the lock stays held, and gets it once released', async () => {
  const root = makeRoot();
  await acquireLock(root, { holder: 'argus' });

  const started = Date.now();
  const timedOut = await lockCliAsync(root, ['acquire', '--holder', 'hermes', '--wait', '600ms']);
  assert.equal(timedOut.status, EXIT_BUSY);
  assert.ok(Date.now() - started >= 600);
  assert.match(timedOut.stderr, /Gave up after waiting/);

  const waiter = lockCliAsync(root, ['acquire', '--holder', 'hermes', '--wait', '10s']);
  setTimeout(() => releaseLock(root, { holder: 'argus' }), 300);
  const result = await waiter;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readLock(root).holder, 'hermes');

  await assert.rejects(acquireLock(root, { holder: 'argus', waitMs: 50, pollMs: 10 }), LockBusyError);
});

test('stale locks: expired TTL and dead pid on this host are taken over with a message', async () => {
  const root = makeRoot();
  await acquireLock(root, { holder: 'argus', ttlMs: 50 });
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.match(lockStatus(root).stale, /expired at/);
  assert.match(lockCli(root, ['status']).stdout, /Stale \(expired at/);
  const takeover = lockCli(root, ['acquire', '--holder', 'hermes']);
  assert.equal(takeover.status, 0, takeover.stderr);
  assert.match(takeover.stderr, /Took over stale cockpit write lock from argus \(expired at/);
  assert.equal(readLock(root).holder, 'hermes');
  releaseLock(root, { holder: 'hermes' });

  const pid = deadPid();
  await acquireLock(root, { holder: 'crashed', pidBound: true, pid });
  const fromDead = lockCli(root, ['acquire', '--holder', 'hermes']);
  assert.equal(fromDead.status, 0, fromDead.stderr);
  assert.match(fromDead.stderr, new RegExp(`from crashed \\(process ${pid} on .* is no longer running\\)`));
  releaseLock(root, { holder: 'hermes' });

  // A dead pid on another host proves nothing; only the TTL applies there.
  await acquireLock(root, { holder: 'remote', pidBound: true, pid, host: 'some-other-host' });
  assert.equal(tryAcquire(root, { holder: 'hermes' }).acquired, false);
  // An unbound (acquire without --pid) lock is never taken over by pid.
  releaseLock(root, { force: true });
  await acquireLock(root, { holder: 'detached', pid });
  assert.equal(tryAcquire(root, { holder: 'hermes' }).acquired, false);
});

test('release by a non-holder is refused; --force releases for operators', async () => {
  const root = makeRoot();
  await acquireLock(root, { holder: 'argus' });
  const refused = lockCli(root, ['release', '--holder', 'hermes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to release: cockpit write lock is held by argus.*not by hermes.*--force/);
  assert.equal(readLock(root).holder, 'argus');

  const missingHolder = lockCli(root, ['release']);
  assert.equal(missingHolder.status, 1);
  assert.match(missingHolder.stderr, /--holder <name> is required/);

  const forced = lockCli(root, ['release', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Released cockpit write lock \(was held by argus/);
  assert.equal(readLock(root), null);

  const nothing = lockCli(root, ['release', '--holder', 'argus']);
  assert.equal(nothing.status, 0);
  assert.match(nothing.stdout, /not locked/);
  assert.match(lockCli(root, ['status']).stdout, /Cockpit write lock: unlocked/);
});

test('lock run holds the lock for the command and releases it even on failure', () => {
  const root = makeRoot();
  const probe = `const fs = require('node:fs'); const lock = JSON.parse(fs.readFileSync(${JSON.stringify(lockPath(root))}, 'utf8'));`
    + ' console.log(lock.holder, lock.pid_bound, process.env.COCKPIT_LOCK_HOLDER); process.exit(3);';
  const failed = lockCli(root, ['run', '--holder', 'argus', '--purpose', 'test', '--', process.execPath, '-e', probe]);
  assert.equal(failed.status, 3, failed.stderr);
  assert.equal(failed.stdout.trim(), 'argus true argus');
  assert.match(failed.stderr, /Acquired cockpit write lock for argus[\s\S]*Released cockpit write lock for argus/);
  assert.equal(readLock(root), null);

  const missing = lockCli(root, ['run', '--holder', 'argus', '--', 'definitely-not-a-command-cockpit']);
  assert.equal(missing.status, 127);
  assert.equal(readLock(root), null);

  const ok = lockCli(root, ['run', '--holder', 'argus', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readLock(root), null);

  const noCommand = lockCli(root, ['run', '--holder', 'argus']);
  assert.equal(noCommand.status, 1);
  assert.match(noCommand.stderr, /run requires a command after --/);
});

test('lock run waits for a busy lock or fails with the busy status; nested runs keep an outer lock', async () => {
  const root = makeRoot();
  await acquireLock(root, { holder: 'hermes' });
  const busy = lockCli(root, ['run', '--holder', 'argus', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(busy.status, EXIT_BUSY);
  assert.match(busy.stderr, /held by hermes/);
  assert.equal(readLock(root).holder, 'hermes');

  // Same holder already holds it (e.g. lock acquire earlier): run proceeds and
  // leaves the outer lock in place for the explicit release.
  const nested = lockCli(root, ['run', '--holder', 'hermes', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(readLock(root).holder, 'hermes');

  const waiter = lockCliAsync(root, ['run', '--holder', 'argus', '--wait', '10s', '--', process.execPath, '-e', 'process.exit(0)']);
  setTimeout(() => releaseLock(root, { holder: 'hermes' }), 300);
  assert.equal((await waiter).status, 0);
  assert.equal(readLock(root), null);
});

test('search-index respects the lock: unchanged when unlocked, refused for others, allowed for the holder', async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'index.html'), '<title>Home</title><h1>Home</h1>');
  const target = path.join(root, '.cockpit', 'search-index.json');
  const index = (args, env = cleanEnv()) => spawnSync(process.execPath, [indexScript, '--root', root, ...args], { env, encoding: 'utf8' });

  const free = index([]);
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stderr, '');
  fs.rmSync(target);

  await acquireLock(root, { holder: 'argus' });
  const blocked = index(['--lock-wait', '0']);
  assert.equal(blocked.status, EXIT_BUSY);
  assert.match(blocked.stderr, /Cockpit write lock is held by argus.*lock\.mjs run --holder/);
  assert.equal(fs.existsSync(target), false);

  const asHolder = index(['--holder', 'argus']);
  assert.equal(asHolder.status, 0, asHolder.stderr);
  const viaEnv = index([], cleanEnv({ COCKPIT_LOCK_HOLDER: 'argus' }));
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  releaseLock(root, { holder: 'argus' });

  const underRun = lockCli(root, ['run', '--holder', 'hermes', '--', process.execPath, indexScript, '--root', root]);
  assert.equal(underRun.status, 0, underRun.stderr);
  assert.match(underRun.stdout, /Wrote .*search-index\.json/);

  // A stale lock does not block; it only warns.
  await acquireLock(root, { holder: 'argus', ttlMs: 1 });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const stale = index(['--lock-wait', '0']);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stderr, /ignoring stale cockpit write lock/);

  await assert.doesNotReject(assertWriteAllowed(root, { holder: 'argus', waitMs: 0 }));
});

test('lock files are gitignored by the starter template and never served', async () => {
  const root = makeRoot();
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (git(['init', '-q']).status !== 0) return;
  const warned = lockCli(root, ['acquire', '--holder', 'argus']);
  assert.match(warned.stderr, /\.cockpit\/lock is not gitignored/);
  assert.equal(JSON.parse(lockCli(root, ['status', '--json']).stdout).gitignored, false);
  fs.copyFileSync(path.join(skillRoot, 'templates', 'cockpit-root', '.gitignore'), path.join(root, '.gitignore'));
  assert.equal(JSON.parse(lockCli(root, ['status', '--json']).stdout).gitignored, true);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']).stdout.includes('.cockpit/lock'), false);

  const server = createServeServer({ root: fs.realpathSync(root), host: '127.0.0.1', port: 0, auth: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const status = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/.cockpit/lock', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});
