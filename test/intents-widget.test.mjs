// Regressions for the browser widget's submission and paging logic. The
// widget's pure helpers run here against the real intents API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { claimIntent, askIntent, createIntent } from '../skill/lib/intents/core.mjs';
import { createIntentsService } from '../skill/scripts/intents-service.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const widgetFile = path.join(repoRoot, 'skill', 'templates', 'cockpit-root', 'cockpit-intents.js');
const ORIGIN = 'https://cockpit.example';
const SECRET = 'b'.repeat(64);
const API = '/api/cockpit/v1';
let counter = 0;

function loadHelpers() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(widgetFile, 'utf8'), sandbox, { filename: widgetFile });
  return sandbox.module.exports;
}
const w = loadHelpers();

function tempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rid() {
  counter += 1;
  return `00000000-0000-4000-9000-${String(counter).padStart(12, '0')}`;
}

function makeRoot() {
  const root = tempDir('cockpit-widget-root-');
  fs.mkdirSync(path.join(root, '.cockpit'));
  fs.writeFileSync(path.join(root, '.cockpit', 'sources.toml'), '');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Home</h1>');
  return root;
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch { /* not json */ }
        // Same shape the widget's api() helper resolves with.
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withService(fn) {
  const root = makeRoot();
  const env = { ...process.env, HOME: tempDir('cockpit-widget-home-'), XDG_STATE_HOME: tempDir('cockpit-widget-state-') };
  const server = createIntentsService({ root, origins: [ORIGIN], secret: SECRET, env });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const auth = { 'X-Cockpit-Proxy-Secret': SECRET, 'X-Cockpit-Principal': 'op' };
  const csrf = (await request(port, { path: `${API}/capabilities`, headers: auth })).data.csrf_token;
  const signedIn = { ...auth, Origin: ORIGIN, 'X-Cockpit-CSRF': csrf, 'Content-Type': 'application/json' };
  const signedOut = { Origin: ORIGIN, 'X-Cockpit-CSRF': csrf, 'Content-Type': 'application/json' };
  const post = (p, body, headers = signedIn) => request(port, { method: 'POST', path: `${API}${p}`, headers, body });
  try {
    await fn({ port, auth, post, signedOut, store: server.intentStore, root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('writeOutcome separates confirmed, definitive rejections, pre-lookup refusals, and unknown', () => {
  assert.equal(w.writeOutcome({ status: 201, ok: true, data: { intent_id: 'x' } }), 'confirmed');
  assert.equal(w.writeOutcome({ status: 200, ok: true, data: { replayed: true } }), 'confirmed');
  assert.equal(w.writeOutcome({ status: 422, ok: false, data: { error: { code: 'invalid_field' } } }), 'rejected');
  assert.equal(w.writeOutcome({ status: 409, ok: false, data: { error: { code: 'idempotency_conflict' } } }), 'rejected');
  assert.equal(w.writeOutcome({ status: 409, ok: false, data: { error: { code: 'version_conflict' } } }), 'rejected');
  for (const [status, code] of [[401, 'authentication_required'], [403, 'csrf_invalid'], [403, 'origin_denied'], [429, 'rate_limited'], [401, undefined], [403, undefined]]) {
    assert.equal(w.writeOutcome({ status, ok: false, data: code ? { error: { code } } : null }), 'refused', `${status} ${code}`);
  }
  assert.equal(w.writeOutcome({ status: 503, ok: false, data: { error: { code: 'store_unavailable' } } }), 'unknown');
  assert.equal(w.writeOutcome({ status: 502, ok: false, data: null }), 'unknown');
  assert.equal(w.writeOutcome({ status: 404, ok: false, data: null }), 'unknown');
  assert.equal(w.writeOutcome(null), 'unknown');
});

test('a first attempt refused by auth is settled: nothing was ever stored under that id', () => {
  let n = 0;
  const track = { requestId: 'id-0', pending: null };
  const pending = w.nextSubmission(track, 'A', (id) => `{"id":"${id}","m":"A"}`);
  const out = w.settleSubmission(track, pending, { status: 401, ok: false, data: null }, 'A', () => `id-${(n += 1)}`);
  assert.equal(out.outcome, 'rejected');
  assert.equal(out.refused, true);
  assert.equal(track.pending, null);
  assert.equal(track.requestId, 'id-1');
});

// Lost 201 -> retry refused (401) -> sign in again -> edit the draft -> Send.
test('create: a lost response survives an auth-refused retry; edits then go out under a fresh id', async () => {
  await withService(async ({ post, signedOut, store }) => {
    const draft = { mode: 'capture', requestId: rid(), message: 'First text', pending: null };
    const snapshot = () => JSON.stringify([draft.requestId, draft.message]);
    const build = (requestId) => JSON.stringify({ schema_version: 1, request_id: requestId, mode: 'capture', operator_message: draft.message, target: null });
    const firstId = draft.requestId;

    // 1. Accepted by the service, but the 201 never reaches the browser.
    let pending = w.nextSubmission(draft, snapshot(), build);
    assert.equal((await post('/intents', pending.body)).status, 201);
    let out = w.settleSubmission(draft, pending, null, snapshot(), rid);
    assert.equal(out.outcome, 'unknown');

    // 2. Retry while signed out: refused before the service looks up the id.
    pending = w.nextSubmission(draft, snapshot(), build);
    const refused = await post('/intents', pending.body, signedOut);
    assert.equal(refused.status, 401);
    out = w.settleSubmission(draft, pending, refused, snapshot(), rid);
    assert.equal(out.outcome, 'unknown', '401 must not settle a body whose earlier attempt may be stored');
    assert.equal(draft.pending, pending, 'exact retry body kept');
    assert.equal(draft.requestId, firstId);

    // 3. Signed back in, the operator edits the draft and presses Send: the
    //    earlier exact body is reconciled first (replayed, not a conflict).
    draft.message = 'Edited text';
    pending = w.nextSubmission(draft, snapshot(), build);
    assert.equal(JSON.parse(pending.body).operator_message, 'First text');
    const replay = await post('/intents', pending.body);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    out = w.settleSubmission(draft, pending, replay, snapshot(), rid);
    assert.deepEqual([out.outcome, out.edited], ['confirmed', true]);
    assert.notEqual(draft.requestId, firstId, 'newer edits get a fresh request id');
    assert.equal(draft.pending, null);

    // 4. Send again: the edit is created as its own request (previously 409).
    pending = w.nextSubmission(draft, snapshot(), build);
    const second = await post('/intents', pending.body);
    assert.equal(second.status, 201, JSON.stringify(second.data));
    out = w.settleSubmission(draft, pending, second, snapshot(), rid);
    assert.deepEqual([out.outcome, out.edited], ['confirmed', false]);
    assert.deepEqual(store.read().intents.map((i) => i.operator_message), ['First text', 'Edited text']);
  });
});

test('reply: a lost response survives an auth-refused retry; edits then go out under a fresh id', async () => {
  await withService(async ({ post, signedOut, store, root }) => {
    const id = store.mutate((state) => {
      const { intent } = createIntent(state, root, { schema_version: 1, request_id: rid(), mode: 'capture', operator_message: 'Do it.', target: null });
      const { token } = claimIntent(state, intent.intent_id);
      askIntent(state, intent.intent_id, token, 'Which one?');
      return intent.intent_id;
    });
    const version = store.read().intents[0].version;
    const d = { text: 'The first one.', requestId: rid(), version, pending: null };
    const build = (requestId) => JSON.stringify({ request_id: requestId, operator_message: d.text, version: d.version });
    const firstId = d.requestId;

    let pending = w.nextSubmission(d, d.text, build);
    assert.equal((await post(`/intents/${id}/replies`, pending.body)).status, 200);
    let out = w.settleSubmission(d, pending, null, d.text, rid); // response lost
    assert.equal(out.outcome, 'unknown');

    pending = w.nextSubmission(d, d.text, build);
    const refused = await post(`/intents/${id}/replies`, pending.body, signedOut);
    assert.equal(refused.status, 401);
    out = w.settleSubmission(d, pending, refused, d.text, rid);
    assert.equal(out.outcome, 'unknown');
    assert.equal(d.pending, pending);
    assert.equal(d.requestId, firstId);

    d.text = 'Actually, the second one.';
    d.version = store.read().intents[0].version; // re-rendered record
    pending = w.nextSubmission(d, d.text, build);
    assert.equal(JSON.parse(pending.body).operator_message, 'The first one.');
    const replay = await post(`/intents/${id}/replies`, pending.body);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    out = w.settleSubmission(d, pending, replay, d.text, rid);
    assert.deepEqual([out.outcome, out.edited], ['confirmed', true]);
    assert.notEqual(d.requestId, firstId);

    pending = w.nextSubmission(d, d.text, build);
    const second = await post(`/intents/${id}/replies`, pending.body);
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.replayed, false);
    assert.deepEqual(store.read().intents[0].messages.filter((m) => m.author === 'operator').map((m) => m.text), ['The first one.', 'Actually, the second one.']);
  });
});

// Load more is in flight across the 5-second poll.
test('paging: polling pauses during Load more and a refresh keeps the requested page', async () => {
  await withService(async ({ port, auth, store, root }) => {
    store.mutate((state) => {
      for (let i = 0; i < 55; i += 1) createIntent(state, root, { schema_version: 1, request_id: rid(), mode: 'capture', operator_message: `Item ${i}`, target: null });
    });
    const page = (cursor) => request(port, { path: `${API}/intents?view=open&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers: auth });
    // Mirrors the widget's loadList: fetch ticket.want pages, apply if current.
    async function refresh(pager) {
      const ticket = w.pagerBeginRefresh(pager, 'open');
      let items = [];
      let cursor = null;
      let got = 0;
      do {
        const result = await page(cursor);
        items = items.concat(result.data.items);
        cursor = result.data.next_cursor;
        got += 1;
      } while (cursor && got < ticket.want);
      return w.pagerFinishRefresh(pager, ticket, got) ? { items, cursor } : null;
    }

    const pager = w.createPager();
    let shown = await refresh(pager);
    assert.equal(shown.items.length, 50);
    assert.ok(shown.cursor);

    // Load more starts; its response is delayed past the next poll.
    const ticket = w.pagerBeginMore(pager, 'open');
    assert.ok(ticket);
    assert.equal(w.pagerBeginMore(pager, 'open'), null, 'one Load more at a time');
    const delayed = page(shown.cursor);
    assert.equal(w.pagerCanPoll(pager), false, 'the poll skips while a page is loading');
    const more = await delayed;
    assert.equal(w.pagerFinishMore(pager, ticket, more.ok), true, 'loaded page is kept');
    shown = { items: shown.items.concat(more.data.items), cursor: more.data.next_cursor };
    assert.equal(shown.items.length, 55);
    assert.equal(shown.cursor, null);
    assert.equal(w.pagerCanPoll(pager), true);

    // The next poll re-fetches the whole loaded range.
    shown = await refresh(pager);
    assert.equal(shown.items.length, 55);

    // A refresh the operator triggers mid-Load-more supersedes it but fetches
    // the page that was asked for, so nothing is lost either way.
    w.pagerReset(pager);
    shown = await refresh(pager);
    const ticket2 = w.pagerBeginMore(pager, 'open');
    const late = page(shown.cursor);
    const forced = await refresh(pager);
    assert.equal(forced.items.length, 55);
    assert.equal(w.pagerFinishMore(pager, ticket2, (await late).ok), false, 'superseded page is dropped, already included');
    assert.equal(pager.pages, 2);
    assert.equal((await refresh(pager)).items.length, 55);

    // Switching tabs resets to one page and drops the in-flight page.
    const ticket3 = w.pagerBeginMore(pager, 'open');
    w.pagerReset(pager);
    assert.equal(w.pagerFinishMore(pager, ticket3, true), false);
    assert.equal(pager.pages, 1);
  });
});
