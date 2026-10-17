/*
 * cockpit-intents.js — optional operator comment/capture widget.
 *
 * Include on any page with:  <script src="/cockpit-intents.js" defer></script>
 * It probes the same-origin /api/cockpit/v1/capabilities endpoint and stays
 * completely hidden when the write service is absent, so static Cockpit
 * sites keep working unchanged. All operator and agent text is rendered as
 * text nodes; nothing from the API is ever parsed as HTML. No drafts or
 * receipts are stored in localStorage or caches.
 */
(function () {
  'use strict';
  if (window.__cockpitIntents) return;
  window.__cockpitIntents = true;

  var API = '/api/cockpit/v1';
  var script = document.currentScript;
  var cssHref = script && script.src ? new URL('cockpit-intents.css', script.src).href : '/cockpit-intents.css';
  var caps = null;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'on') Object.keys(value).forEach(function (ev) { node.addEventListener(ev, value[ev]); });
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function pagePath() {
    var p;
    try { p = decodeURIComponent(location.pathname); } catch (e) { return null; }
    if (!/\/$|\.html$/.test(p)) p += '/';
    if (/[\\?#%]/.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
    return p;
  }

  function fetchCapabilities() {
    return fetch(API + '/capabilities', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok || !/application\/json/.test(res.headers.get('content-type') || '')) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || data.protocol_version !== 1 || typeof data.csrf_token !== 'string' || !data.features) return null;
        if (!Array.isArray(data.type_hints)) data.type_hints = [];
        return data;
      });
  }

  // The body is serialized once, so a CSRF retry resends exactly the same
  // bytes (same request_id and version).
  function api(method, path, body, retried) {
    var headers = { Accept: 'application/json' };
    var payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Cockpit-CSRF'] = caps.csrf_token;
    }
    return fetch(API + path, {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: headers,
      body: payload,
    }).then(function (res) {
      var json = /application\/json/.test(res.headers.get('content-type') || '') ? res.json() : Promise.resolve(null);
      return json.then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
    }).then(function (result) {
      var code = result.data && result.data.error && result.data.error.code;
      if (payload === undefined || retried || result.status !== 403 || code !== 'csrf_invalid') return result;
      // The service restarted (new CSRF secret) or the session changed:
      // refresh capabilities once and retry the identical request.
      return fetchCapabilities().then(function (fresh) {
        if (!fresh) return result;
        caps.csrf_token = fresh.csrf_token;
        return api(method, path, payload, true);
      }, function () { return result; });
    });
  }

  function errorText(result) {
    if (result.status === 401) return 'Sign-in required. Your draft is kept; sign in and retry.';
    var err = result.data && result.data.error;
    if (err && err.message) return err.message + (err.field ? ' (' + err.field + ')' : '');
    return 'Request failed (HTTP ' + result.status + ').';
  }

  function stateClass(intent) {
    return 'ci-state ci-state-' + intent.state;
  }

  function shortTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  function safeRoute(page) {
    return typeof page === 'string' && page.charAt(0) === '/' && page.charAt(1) !== '/' ? page : null;
  }

  // ---------- UI ----------
  var root, panel, title, body, live, launcherButtons = {}, lastOpener = null;
  var mode = null; // 'comment' | 'capture' | 'requests'
  var drafts = {}; // per composer mode: { mode, requestId, message, quote, url, type }
  var draft = null; // drafts[mode] while a composer is shown
  var replyDrafts = {}; // per intent id: { text, requestId, version, note }
  var receipt = null; // last intent receipt shown in composer
  var listSeq = 0; // bumps on every list load; stale responses are ignored
  var pagesLoaded = 1; // pages shown in the current view (Load more adds one)
  var view = 'open';
  var pollTimer = null, pollDelay = 5000;

  function announce(text) {
    live.textContent = '';
    window.setTimeout(function () { live.textContent = text; }, 30);
  }

  function build() {
    var link = el('link', { rel: 'stylesheet', href: cssHref });
    document.head.appendChild(link);
    live = el('div', { class: 'ci-sr', 'aria-live': 'polite', role: 'status' });
    var bar = el('div', { class: 'ci-bar', role: 'toolbar', 'aria-label': 'Operator requests' });
    if (caps.features.page_comments && pagePath()) {
      launcherButtons.comment = el('button', { type: 'button', class: 'ci-launch', text: 'Comment', 'aria-label': 'Comment on this page', on: { click: function (e) { open('comment', e.currentTarget); } } });
      bar.appendChild(launcherButtons.comment);
    }
    if (caps.features.capture) {
      launcherButtons.capture = el('button', { type: 'button', class: 'ci-launch', text: 'Capture', on: { click: function (e) { open('capture', e.currentTarget); } } });
      bar.appendChild(launcherButtons.capture);
    }
    launcherButtons.requests = el('button', { type: 'button', class: 'ci-launch', text: 'Requests', on: { click: function (e) { open('requests', e.currentTarget); } } });
    bar.appendChild(launcherButtons.requests);

    title = el('h2', { class: 'ci-title', id: 'ci-title' });
    var close = el('button', { type: 'button', class: 'ci-close', 'aria-label': 'Close', text: '×', on: { click: closePanel } });
    body = el('div', { class: 'ci-body' });
    panel = el('section', { class: 'ci-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'ci-title', hidden: true }, [
      el('div', { class: 'ci-head' }, [title, close]), body,
    ]);
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } });
    root = el('div', { class: 'cockpit-intents' }, [bar, panel, live]);
    document.body.appendChild(root);
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopPolling(); else if (!panel.hidden) schedule(0); });
    window.addEventListener('beforeunload', function (e) {
      if (hasUnsentText()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function hasUnsentText() {
    var any = Object.keys(drafts).some(function (k) {
      var d = drafts[k];
      return d.message.trim() !== '' || d.quote.trim() !== '' || d.url.trim() !== '' || !!d.pending;
    });
    return any || Object.keys(replyDrafts).some(function (k) { return replyDrafts[k].text.trim() !== '' || !!replyDrafts[k].pending; });
  }

  function open(next, opener) {
    lastOpener = opener || lastOpener;
    if (mode !== next || next === 'requests') receipt = null;
    if (next === 'requests') pagesLoaded = 1;
    if (next === 'comment' || next === 'capture') {
      // Each mode keeps its own in-memory draft; switching never discards one.
      if (!drafts[next]) drafts[next] = newDraft(next);
      draft = drafts[next];
    }
    mode = next;
    panel.hidden = false;
    render();
    var focusTarget = panel.querySelector('textarea, .ci-tab[aria-selected="true"]');
    if (focusTarget) focusTarget.focus();
    schedule(next === 'requests' ? 0 : 5000);
  }

  function newDraft(kind, empty) {
    var selection = '';
    if (kind === 'comment' && !empty && window.getSelection) {
      selection = String(window.getSelection()).trim().slice(0, 4000);
      if (root && root.contains(window.getSelection().anchorNode)) selection = '';
    }
    return { mode: kind, requestId: uuid(), message: '', quote: selection, url: '', type: '' };
  }

  function closePanel() {
    panel.hidden = true;
    stopPolling();
    if (lastOpener) lastOpener.focus();
  }

  function render() {
    body.textContent = '';
    if (mode === 'requests') return renderRequests();
    renderComposer();
  }

  function field(labelText, control, hint) {
    var id = 'ci-' + Math.random().toString(36).slice(2);
    control.id = id;
    var hintNode = null;
    if (hint) {
      hintNode = el('p', { class: 'ci-hint', id: id + '-hint', text: hint });
      control.setAttribute('aria-describedby', id + '-hint');
    }
    return el('div', { class: 'ci-field' }, [el('label', { for: id, text: labelText }), control, hintNode]);
  }

  function renderComposer() {
    var isComment = mode === 'comment';
    title.textContent = isComment ? 'Comment on this page' : 'Capture';
    var target = pagePath();
    if (isComment) body.appendChild(el('p', { class: 'ci-target' }, ['Page: ', el('code', { text: target })]));
    var message = el('textarea', { rows: 4, required: true, maxlength: 8000 });
    message.value = draft.message;
    message.addEventListener('input', function () { draft.message = message.value; });
    var quote = el('textarea', { rows: 2, maxlength: 8000 });
    quote.value = draft.quote;
    quote.addEventListener('input', function () { draft.quote = quote.value; });
    var form = el('form', { class: 'ci-form', novalidate: true });
    form.appendChild(field(isComment ? 'What should change or be checked?' : 'What should be saved or done?', message, 'This is your instruction to the agent.'));
    if (isComment) {
      var type = el('select', null, [el('option', { value: '', text: 'No type' })].concat(caps.type_hints.map(function (t) { return el('option', { value: t, text: t }); })));
      type.value = draft.type;
      type.addEventListener('change', function () { draft.type = type.value; });
      form.appendChild(field('Type (optional hint)', type));
      form.appendChild(field('Quoted text (optional)', quote, 'Treated as data, not as instructions.'));
    } else {
      var url = el('input', { type: 'url', inputmode: 'url', maxlength: 2048, placeholder: 'https://' });
      url.value = draft.url;
      url.addEventListener('input', function () { draft.url = url.value; });
      form.appendChild(field('Link (optional)', url, 'Not fetched by the service.'));
      form.appendChild(field('Captured material (optional)', quote, 'Pasted source text. Treated as data, not as instructions.'));
    }
    var submit = el('button', { type: 'submit', class: 'ci-primary', text: 'Send' });
    var status = el('p', { class: 'ci-status' });
    form.appendChild(el('div', { class: 'ci-actions' }, [submit, el('span', { class: 'ci-hint', text: 'Ctrl/⌘+Enter to send' })]));
    form.appendChild(status);
    message.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var submitted = draft;
      // An unconfirmed earlier POST (lost response) is retried with its exact
      // original body first, so the service replays it instead of reporting
      // idempotency_conflict; newer edits are kept for a separate request.
      var pending = submitted.pending;
      if (!pending) {
        if (!submitted.message.trim()) { status.textContent = 'Write a message first.'; message.focus(); return; }
        var payload = {};
        if (submitted.quote.trim()) payload[isComment ? 'selected_text' : 'text'] = submitted.quote;
        if (!isComment && submitted.url.trim()) payload.url = submitted.url.trim();
        var req = {
          schema_version: 1,
          request_id: submitted.requestId,
          mode: submitted.mode,
          operator_message: submitted.message,
          target: isComment ? { page: target } : null,
        };
        if (isComment && submitted.type) req.type_hint = submitted.type;
        if (Object.keys(payload).length) req.payload = payload;
        pending = submitted.pending = { body: JSON.stringify(req), snapshot: draftSnapshot(submitted) };
      }
      var confirming = draftSnapshot(submitted) !== pending.snapshot;
      submit.disabled = true;
      status.textContent = confirming ? 'Confirming your earlier submission first…' : 'Sending…';
      api('POST', '/intents', pending.body).then(function (result) {
        submit.disabled = false;
        if (result.status === 201 || (result.status === 200 && result.data && result.data.replayed)) {
          if (submitted.pending === pending) submitted.pending = null;
          // A late response must not erase edits made after sending, or a
          // different mode's draft.
          var unchanged = draftSnapshot(submitted) === pending.snapshot;
          if (drafts[submitted.mode] === submitted) {
            if (unchanged) drafts[submitted.mode] = newDraft(submitted.mode, true);
            else submitted.requestId = uuid(); // edited since sending: keep text, new request next time
          }
          var newReceipt = { intent_id: result.data.intent_id, status: 'Received', state: result.data.state, mode: submitted.mode };
          announce('Received. Request ' + newReceipt.intent_id.slice(0, 8) + ' is pending.');
          if (mode === submitted.mode && !panel.hidden) {
            receipt = newReceipt;
            if (unchanged) {
              draft = drafts[mode];
              render();
            } else {
              showReceipt();
              if (status.isConnected) status.textContent = 'Your earlier submission was received. Your newer edits are kept here; press Send to submit them as a new request.';
            }
            schedule(5000);
          }
          return;
        }
        if (result.status >= 500) {
          // Outcome unknown: keep the pending body for an exact retry.
          if (status.isConnected) status.textContent = 'Receipt not confirmed; retry this submission (it will not be duplicated).';
        } else {
          // Definitively rejected; nothing was stored under this request id.
          if (submitted.pending === pending) submitted.pending = null;
          if (status.isConnected) status.textContent = errorText(result);
        }
        if (status.isConnected) announce(status.textContent);
      }, function () {
        submit.disabled = false;
        if (!status.isConnected) return;
        status.textContent = 'Receipt not confirmed; retry this submission (it will not be duplicated).';
        announce(status.textContent);
      });
    });
    if (receipt) body.appendChild(renderReceipt());
    body.appendChild(form);
  }

  function draftSnapshot(d) {
    return JSON.stringify([d.mode, d.requestId, d.message, d.quote, d.url, d.type]);
  }

  function showReceipt() {
    var old = body.querySelector('.ci-receipt');
    if (old) old.replaceWith(renderReceipt());
    else body.insertBefore(renderReceipt(), body.firstChild);
  }

  function renderReceipt() {
    return el('div', { class: 'ci-receipt' }, [
      el('span', { class: 'ci-state ci-state-' + receipt.state, text: receipt.status }),
      ' Request ', el('code', { text: receipt.intent_id.slice(0, 8) }), ' ',
      el('button', { type: 'button', class: 'ci-link', text: 'View requests', on: { click: function () { open('requests'); } } }),
    ]);
  }

  function renderRequests() {
    title.textContent = 'Requests';
    var tabs = el('div', { class: 'ci-tabs', role: 'tablist', 'aria-label': 'Request views' });
    [['open', 'Active'], ['history', 'Done']].forEach(function (pair) {
      var selected = view === pair[0];
      var tab = el('button', { type: 'button', role: 'tab', class: 'ci-tab', 'aria-selected': selected ? 'true' : 'false', tabindex: selected ? '0' : '-1', text: pair[1] });
      tab.addEventListener('click', function () { view = pair[0]; pagesLoaded = 1; render(); body.querySelector('.ci-tab[aria-selected="true"]').focus(); schedule(0); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); view = view === 'open' ? 'history' : 'open'; pagesLoaded = 1; render(); body.querySelector('.ci-tab[aria-selected="true"]').focus(); schedule(0); }
      });
      tabs.appendChild(tab);
    });
    body.appendChild(tabs);
    body.appendChild(el('div', { class: 'ci-list', role: 'tabpanel', 'aria-busy': 'true' }, [el('p', { class: 'ci-hint', text: 'Loading…' })]));
  }

  function isEditingReply() {
    var active = document.activeElement;
    return !!(active && active.closest && active.closest('.ci-reply'));
  }

  function fetchPage(forView, cursor) {
    return api('GET', '/intents?view=' + forView + '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
  }

  function moreButton(cursor) {
    return el('button', { type: 'button', class: 'ci-link ci-more', text: 'Load more', on: { click: function () { loadMore(cursor); } } });
  }

  // Refresh the list, preserving the loaded range: re-fetch as many pages as
  // the operator has loaded (via Load more) and replace them all at once.
  // force: replace even if a reply form has focus (right after the operator's
  // own action). focusId: intent to focus after rendering.
  function loadList(force, focusId) {
    var list = body.querySelector('.ci-list');
    if (!list) return Promise.resolve(true);
    var forView = view;
    var seq = ++listSeq;
    var want = pagesLoaded;
    var items = [];
    var cursor = null;
    var got = 0;
    function step() {
      return fetchPage(forView, cursor).then(function (result) {
        if (!result.ok) return result;
        items = items.concat(result.data.items);
        cursor = result.data.next_cursor;
        got += 1;
        if (cursor && got < want && seq === listSeq) return step();
        return result;
      });
    }
    return step().then(function (result) {
      // Ignore responses superseded by a newer load (including Load more), a
      // view/mode change, or that arrive while the operator is typing a reply.
      if (seq !== listSeq || mode !== 'requests' || view !== forView || !list.isConnected) return true;
      if (!force && isEditingReply()) return true;
      list.setAttribute('aria-busy', 'false');
      if (!result.ok) {
        var old = list.querySelector('.ci-status');
        if (old) old.remove();
        list.insertBefore(el('p', { class: 'ci-status', text: errorText(result) }), list.firstChild);
        return false;
      }
      list.textContent = '';
      if (!items.length) {
        list.appendChild(el('p', { class: 'ci-hint', text: forView === 'open' ? 'No active requests.' : 'No completed requests yet.' }));
      }
      items.forEach(function (intent) { list.appendChild(renderIntent(intent)); });
      if (focusId) {
        var target = list.querySelector('[data-intent-id="' + focusId + '"]');
        if (target) target.focus();
      }
      if (cursor) list.appendChild(moreButton(cursor));
      return true;
    }, function () {
      if (seq !== listSeq) return false;
      list.setAttribute('aria-busy', 'false');
      if (!list.querySelector('.ci-status')) list.insertBefore(el('p', { class: 'ci-status', text: 'Service temporarily unavailable.' }), list.firstChild);
      return false;
    });
  }

  function loadMore(cursor) {
    var list = body.querySelector('.ci-list');
    if (!list) return;
    var forView = view;
    var seq = ++listSeq; // supersedes any refresh already in flight
    var button = list.querySelector('.ci-more');
    if (button) button.disabled = true;
    fetchPage(forView, cursor).then(function (result) {
      if (seq !== listSeq || mode !== 'requests' || view !== forView || !list.isConnected) return;
      if (button) button.remove();
      if (!result.ok) { list.appendChild(el('p', { class: 'ci-status', text: errorText(result) })); list.appendChild(moreButton(cursor)); return; }
      pagesLoaded += 1;
      var first = null;
      result.data.items.forEach(function (intent) {
        var node = renderIntent(intent);
        if (!first) first = node;
        list.appendChild(node);
      });
      if (result.data.next_cursor) list.appendChild(moreButton(result.data.next_cursor));
      if (first) first.focus();
    }, function () {
      if (seq !== listSeq) return;
      if (button) button.disabled = false;
      announce('Could not load more; try again.');
    });
  }

  function renderIntent(intent) {
    var meta = [el('span', { class: stateClass(intent), text: intent.status }), ' ', intent.mode === 'comment' ? 'Comment' : 'Capture'];
    if (intent.type_hint) meta.push(' · ' + intent.type_hint);
    meta.push(' · ' + shortTime(intent.created_at));
    var item = el('article', { class: 'ci-item', 'data-intent-id': intent.intent_id, tabindex: '-1' }, [el('p', { class: 'ci-meta' }, meta)]);
    var page = intent.target && safeRoute(intent.target.page);
    if (page) item.appendChild(el('p', { class: 'ci-small' }, ['On ', el('a', { href: page, text: page })]));
    item.appendChild(el('p', { class: 'ci-message', text: intent.operator_message }));
    intent.messages.forEach(function (m) {
      item.appendChild(el('p', { class: 'ci-msg ci-msg-' + m.author }, [el('strong', { text: m.author === 'operator' ? 'You: ' : 'Agent asks: ' }), m.text]));
    });
    if (intent.result) {
      var r = intent.result;
      var res = el('div', { class: 'ci-result' }, [el('p', null, [el('strong', { text: 'Outcome: ' }), r.outcome.replace(/_/g, ' ')]), el('p', { text: r.summary })]);
      (r.refs || []).forEach(function (ref) {
        var route = safeRoute(ref.page);
        if (route) res.appendChild(el('p', { class: 'ci-small' }, ['Page: ', el('a', { href: route, text: route })]));
      });
      if (r.commit) res.appendChild(el('p', { class: 'ci-small' }, ['Commit: ', el('code', { title: r.commit, text: r.commit.slice(0, 12) })]));
      item.appendChild(res);
    }
    if (intent.archive) item.appendChild(el('p', { class: 'ci-small', text: 'Archived: ' + intent.archive.reason.replace(/_/g, ' ') }));
    var actions = el('div', { class: 'ci-actions' });
    var canReply = intent.state === 'needs-input' || (intent.state === 'open' && !intent.processing.claimed);
    if (canReply) {
      actions.appendChild(replyForm(intent));
    } else {
      if (intent.state === 'open' && intent.processing.claimed) {
        item.appendChild(el('p', { class: 'ci-small', text: 'An agent is working on this request. You can reply once it asks a question or finishes.' }));
      }
      var stranded = replyDrafts[intent.intent_id];
      if (stranded && stranded.text.trim()) actions.appendChild(strandedDraft(intent, stranded));
    }
    if (intent.state === 'addressed' || ((intent.state === 'open' || intent.state === 'needs-input') && !intent.processing.claimed)) {
      actions.appendChild(el('button', { type: 'button', class: 'ci-link', text: intent.state === 'addressed' ? 'Archive' : 'Cancel request', on: { click: function (e) {
        if (intent.state !== 'addressed' && !window.confirm('Cancel this request?')) return;
        e.currentTarget.disabled = true;
        api('POST', '/intents/' + intent.intent_id + '/archive', { request_id: uuid(), version: intent.version }).then(function (result) {
          announce(result.ok ? 'Archived.' : errorText(result));
          refreshList();
        }, function () { announce('Archive not confirmed; try again.'); refreshList(); });
      } } }));
    }
    if (actions.childNodes.length) item.appendChild(actions);
    return item;
  }

  // An unsent reply for a request that can no longer take one stays visible
  // (as text) until the operator copies or discards it.
  function strandedDraft(intent, d) {
    return el('div', { class: 'ci-reply-stranded' }, [
      el('p', { class: 'ci-small', text: 'Unsent reply (this request cannot take replies right now):' }),
      el('p', { class: 'ci-msg', text: d.text }),
      el('button', { type: 'button', class: 'ci-link', text: 'Discard unsent reply', on: { click: function () {
        delete replyDrafts[intent.intent_id];
        refreshList(true, intent.intent_id);
      } } }),
    ]);
  }

  function replyForm(intent) {
    var id = intent.intent_id;
    var d = replyDrafts[id];
    if (!d) d = replyDrafts[id] = { text: '', requestId: uuid(), version: intent.version, note: '' };
    // The rendered record is what the operator is replying to.
    d.version = intent.version;
    var box = el('textarea', { rows: 2, maxlength: 8000 });
    box.value = d.text;
    box.addEventListener('input', function () { d.text = box.value; });
    var status = el('p', { class: 'ci-status', text: d.note || '' });
    var send = el('button', { type: 'submit', class: intent.state === 'needs-input' ? 'ci-primary' : 'ci-secondary', text: intent.state === 'needs-input' ? 'Answer' : 'Add follow-up' });
    var form = el('form', { class: 'ci-reply' }, [field(intent.state === 'needs-input' ? 'Your answer' : 'Follow-up', box), send, status]);
    box.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // Retry an unconfirmed reply with its exact original body (request id,
      // text, and version), even if the record was re-rendered since.
      var pending = d.pending;
      if (!pending) {
        if (!d.text.trim()) { status.textContent = 'Write a reply first.'; return; }
        pending = d.pending = { body: JSON.stringify({ request_id: d.requestId, operator_message: d.text, version: d.version }), text: d.text };
      }
      var sentText = pending.text;
      send.disabled = true;
      api('POST', '/intents/' + id + '/replies', pending.body).then(function (result) {
        send.disabled = false;
        if (result.status < 500 && d.pending === pending) d.pending = null;
        if (result.ok) {
          // Acknowledged: clear this draft (text, request id, version) unless
          // it was edited after sending, in which case keep the newer text
          // under a fresh request id.
          if (replyDrafts[id] === d) {
            if (d.text === sentText) delete replyDrafts[id];
            else { d.requestId = uuid(); d.note = 'Earlier text was sent; this edit is not sent yet.'; }
          }
          announce('Reply received.');
          refreshList(true, id);
          return;
        }
        var code = result.data && result.data.error && result.data.error.code;
        if (code === 'version_conflict' || code === 'claim_conflict' || code === 'invalid_transition') {
          reloadIntent(id, d, code);
          return;
        }
        status.textContent = result.status >= 500 ? 'Receipt not confirmed; retry (it will not be duplicated).' : errorText(result);
        announce(status.textContent);
      }, function () {
        send.disabled = false;
        status.textContent = 'Receipt not confirmed; retry (it will not be duplicated).';
      });
    });
    return form;
  }

  // After a conflict, fetch the current record, keep the draft, and re-render
  // just this request so the operator can review it and retry (or see why a
  // reply is no longer possible).
  function reloadIntent(id, d, code) {
    api('GET', '/intents/' + id).then(function (result) {
      var item = body.querySelector('[data-intent-id="' + id + '"]');
      if (!result.ok) {
        if (item) {
          var st = item.querySelector('.ci-reply .ci-status');
          if (st) st.textContent = errorText(result);
        }
        return;
      }
      var fresh = result.data;
      d.version = fresh.version;
      var replyable = fresh.state === 'needs-input' || (fresh.state === 'open' && !fresh.processing.claimed);
      d.note = replyable
        ? 'This request changed (now: ' + fresh.status + '). Review it, then send again.'
        : '';
      var msg = replyable ? d.note : 'This request can no longer take replies (now: ' + fresh.status + '). Your text is kept below.';
      announce(msg);
      if (item && item.isConnected) {
        var replacement = renderIntent(fresh);
        item.replaceWith(replacement);
        var again = replacement.querySelector('.ci-reply textarea');
        if (again) again.focus();
        else replacement.focus();
      }
    }, function () {
      announce(code === 'version_conflict' ? 'This request changed; reload Requests to review it.' : 'Could not refresh this request.');
    });
  }

  // ---------- Polling (only while the panel is open and the tab visible) ----------
  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedule(delay) {
    stopPolling();
    if (panel.hidden || document.hidden) return;
    pollTimer = window.setTimeout(tick, delay);
  }

  function refreshList(force, focusId) {
    if (mode !== 'requests' || panel.hidden) return;
    stopPolling();
    pollDelay = 5000;
    loadList(force, focusId).then(function (ok) {
      pollDelay = ok ? 5000 : Math.min(60000, pollDelay * 2);
      schedule(pollDelay);
    });
  }

  function tick() {
    var work;
    if (mode === 'requests') {
      // While a reply is being typed, skip this refresh but keep polling alive.
      if (isEditingReply()) { schedule(pollDelay); return; }
      if (!body.querySelector('.ci-list')) render();
      work = loadList();
    } else if (receipt) {
      var polled = receipt;
      work = api('GET', '/intents/' + polled.intent_id).then(function (result) {
        // Ignore responses for a receipt that is no longer the one shown.
        if (receipt !== polled) return true;
        if (!result.ok) return false;
        var changed = result.data.status !== polled.status;
        polled.status = result.data.status;
        polled.state = result.data.state;
        if (changed) {
          var old = body.querySelector('.ci-receipt');
          if (old) old.replaceWith(renderReceipt());
          announce('Request ' + polled.intent_id.slice(0, 8) + ': ' + polled.status + '.');
        }
        return true;
      }, function () { return false; });
    } else {
      return;
    }
    work.then(function (ok) {
      pollDelay = ok ? 5000 : Math.min(60000, pollDelay * 2);
      schedule(pollDelay);
    });
  }

  // ---------- Capability detection ----------
  function start() {
    fetchCapabilities()
      .then(function (data) {
        if (!data) return;
        caps = data;
        build();
      })
      .catch(function () { /* service absent: stay hidden */ });
  }

  if (location.protocol === 'http:' || location.protocol === 'https:') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
