#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot } from '../lib/config.mjs';
import { assertNode20 } from '../lib/paths.mjs';
import { EXIT_BUSY, LockError, assertWriteAllowed, parseDuration, validateHolder } from '../lib/lock.mjs';
import { buildSearchIndex, discoverHtmlPages, extractIndexPage, renderedAtForHtml, rootRelative } from '../lib/contract.mjs';

function usage() {
  return `Usage: node scripts/search-index.mjs [--root <path>] [--holder <name>] [--lock-wait <duration>]

If another agent holds the cockpit write lock (see lock.mjs), waits up to
--lock-wait (default 10s) and then fails with exit status ${EXIT_BUSY}. Pass --holder (or
set COCKPIT_LOCK_HOLDER; lock.mjs run does this) to write under your own lock.
`;
}

function parseArgs(argv) {
  const options = { rootArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root' || arg === '--cockpit-root') {
      let value = argv[i + 1];
      if (value === '--') {
        value = argv[i + 2];
        if (!value) throw new Error(`${arg} requires a path argument`);
        options.rootArgs.push(`${arg}=${value}`);
        i += 2;
      } else {
        if (!value || value.startsWith('-')) throw new Error(`${arg} requires a path argument`);
        options.rootArgs.push(arg, value);
        i += 1;
      }
    } else if (arg.startsWith('--root=') || arg.startsWith('--cockpit-root=')) options.rootArgs.push(arg);
    else if (arg === '--holder' || arg === '--lock-wait') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      options[arg === '--holder' ? 'holder' : 'lockWait'] = value;
      i += 1;
    } else if (arg.startsWith('--holder=')) options.holder = arg.slice('--holder='.length);
    else if (arg.startsWith('--lock-wait=')) options.lockWait = arg.slice('--lock-wait='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function generate(root) {
  const files = discoverHtmlPages(root);
  const pages = files.map((file) => {
    const pagePath = rootRelative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    return { renderedAt: renderedAtForHtml(html), record: extractIndexPage({ pagePath, html }) };
  });
  return buildSearchIndex(pages);
}

try {
  assertNode20();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const { root } = resolveRoot({ argv: options.rootArgs, env: process.env, forWrite: true, stderr: process.stderr });
  const holder = options.holder ?? (process.env.COCKPIT_LOCK_HOLDER || undefined);
  if (holder !== undefined) validateHolder(holder);
  await assertWriteAllowed(root, {
    holder,
    waitMs: options.lockWait === undefined ? 10_000 : parseDuration(options.lockWait, '--lock-wait'),
    stderr: process.stderr,
  });
  const index = generate(root);
  const dir = path.join(root, '.cockpit');
  const target = path.join(dir, 'search-index.json');
  const temp = path.join(dir, `.search-index.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  process.stdout.write(`Wrote ${target} (${index.page_count} page(s))\n`);
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = error instanceof LockError && error.code === 'lock_busy' ? EXIT_BUSY : 1;
}
