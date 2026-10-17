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

  function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Cockpit-CSRF'] = caps.csrf_token;
    }
    return fetch(API + path, {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      var json = /application\/json/.test(res.headers.get('content-type') || '') ? res.json() : Promise.resolve(null);
      return json.then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
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
  var draft = null; // { requestId, message, quote, url, type }
  var receipt = null; // last intent receipt shown in composer
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
      if (draft && draft.message && draft.message.trim()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function open(next, opener) {
    lastOpener = opener || lastOpener;
    if (mode !== next || next === 'requests') receipt = null;
    if ((next === 'comment' || next === 'capture') && (!draft || draft.mode !== next)) {
      if (draft && draft.message && draft.message.trim() && !window.confirm('Discard the unsent draft?')) next = draft.mode;
      else draft = newDraft(next);
    }
    mode = next;
    panel.hidden = false;
    render();
    var focusTarget = panel.querySelector('textarea, .ci-tab[aria-selected="true"]');
    if (focusTarget) focusTarget.focus();
    schedule(next === 'requests' ? 0 : 5000);
  }

  function newDraft(kind) {
    var selection = '';
    if (kind === 'comment' && window.getSelection) {
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
      if (!draft.message.trim()) { status.textContent = 'Write a message first.'; message.focus(); return; }
      submit.disabled = true;
      status.textContent = 'Sending…';
      var payload = {};
      if (draft.quote.trim()) payload[isComment ? 'selected_text' : 'text'] = draft.quote;
      if (!isComment && draft.url.trim()) payload.url = draft.url.trim();
      var req = {
        schema_version: 1,
        request_id: draft.requestId,
        mode: mode,
        operator_message: draft.message,
        target: isComment ? { page: target } : null,
      };
      if (isComment && draft.type) req.type_hint = draft.type;
      if (Object.keys(payload).length) req.payload = payload;
      api('POST', '/intents', req).then(function (result) {
        submit.disabled = false;
        if (result.status === 201 || (result.status === 200 && result.data && result.data.replayed)) {
          receipt = { intent_id: result.data.intent_id, status: 'Received', state: result.data.state };
          draft = newDraft(mode);
          draft.quote = '';
          render();
          announce('Received. Request ' + receipt.intent_id.slice(0, 8) + ' is pending.');
          schedule(5000);
        } else {
          status.textContent = errorText(result);
          announce(status.textContent);
        }
      }, function () {
        submit.disabled = false;
        status.textContent = 'Receipt not confirmed; retry this submission (it will not be duplicated).';
        announce(status.textContent);
      });
    });
    if (receipt) body.appendChild(renderReceipt());
    body.appendChild(form);
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
      tab.addEventListener('click', function () { view = pair[0]; render(); body.querySelector('.ci-tab[aria-selected="true"]').focus(); schedule(0); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); view = view === 'open' ? 'history' : 'open'; render(); body.querySelector('.ci-tab[aria-selected="true"]').focus(); schedule(0); }
      });
      tabs.appendChild(tab);
    });
    body.appendChild(tabs);
    body.appendChild(el('div', { class: 'ci-list', role: 'tabpanel', 'aria-busy': 'true' }, [el('p', { class: 'ci-hint', text: 'Loading…' })]));
  }

  function loadList(cursor) {
    var list = body.querySelector('.ci-list');
    if (!list) return Promise.resolve(true);
    var forView = view;
    return api('GET', '/intents?view=' + forView + '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')).then(function (result) {
      if (mode !== 'requests' || view !== forView) return true;
      if (!cursor) list.textContent = '';
      list.setAttribute('aria-busy', 'false');
      var more = list.querySelector('.ci-more');
      if (more) more.remove();
      if (!result.ok) { list.appendChild(el('p', { class: 'ci-status', text: errorText(result) })); return false; }
      if (!result.data.items.length && !cursor) {
        list.appendChild(el('p', { class: 'ci-hint', text: forView === 'open' ? 'No active requests.' : 'No completed requests yet.' }));
      }
      result.data.items.forEach(function (intent) { list.appendChild(renderIntent(intent)); });
      if (result.data.next_cursor) {
        list.appendChild(el('button', { type: 'button', class: 'ci-link ci-more', text: 'Load more', on: { click: function () { loadList(result.data.next_cursor); } } }));
      }
      return true;
    }, function () {
      list.setAttribute('aria-busy', 'false');
      if (!list.querySelector('.ci-status')) list.appendChild(el('p', { class: 'ci-status', text: 'Service temporarily unavailable.' }));
      return false;
    });
  }

  function renderIntent(intent) {
    var meta = [el('span', { class: stateClass(intent), text: intent.status }), ' ', intent.mode === 'comment' ? 'Comment' : 'Capture'];
    if (intent.type_hint) meta.push(' · ' + intent.type_hint);
    meta.push(' · ' + shortTime(intent.created_at));
    var item = el('article', { class: 'ci-item' }, [el('p', { class: 'ci-meta' }, meta)]);
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
    if (intent.state === 'needs-input' || intent.state === 'open') actions.appendChild(replyForm(intent));
    if (intent.state === 'addressed' || ((intent.state === 'open' || intent.state === 'needs-input') && !intent.processing.claimed)) {
      actions.appendChild(el('button', { type: 'button', class: 'ci-link', text: intent.state === 'addressed' ? 'Archive' : 'Cancel request', on: { click: function (e) {
        if (intent.state !== 'addressed' && !window.confirm('Cancel this request?')) return;
        e.currentTarget.disabled = true;
        api('POST', '/intents/' + intent.intent_id + '/archive', { request_id: uuid(), version: intent.version }).then(function (result) {
          announce(result.ok ? 'Archived.' : errorText(result));
          schedule(0);
        });
      } } }));
    }
    if (actions.childNodes.length) item.appendChild(actions);
    return item;
  }

  function replyForm(intent) {
    var requestId = uuid();
    var box = el('textarea', { rows: 2, maxlength: 8000 });
    var status = el('p', { class: 'ci-status' });
    var send = el('button', { type: 'submit', class: intent.state === 'needs-input' ? 'ci-primary' : 'ci-secondary', text: intent.state === 'needs-input' ? 'Answer' : 'Add follow-up' });
    var form = el('form', { class: 'ci-reply' }, [field(intent.state === 'needs-input' ? 'Your answer' : 'Follow-up', box), send, status]);
    box.addEventListener('focus', stopPolling);
    box.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!box.value.trim()) { status.textContent = 'Write a reply first.'; return; }
      send.disabled = true;
      api('POST', '/intents/' + intent.intent_id + '/replies', { request_id: requestId, operator_message: box.value, version: intent.version }).then(function (result) {
        send.disabled = false;
        if (result.ok) { announce('Reply received.'); schedule(0); }
        else { status.textContent = errorText(result); announce(status.textContent); }
      }, function () {
        send.disabled = false;
        status.textContent = 'Receipt not confirmed; retry (it will not be duplicated).';
      });
    });
    return form;
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

  function tick() {
    var work;
    if (mode === 'requests') {
      var active = document.activeElement;
      if (active && active.closest && active.closest('.ci-reply')) return;
      if (!body.querySelector('.ci-list')) render();
      work = loadList(null);
    } else if (receipt) {
      work = api('GET', '/intents/' + receipt.intent_id).then(function (result) {
        if (!result.ok) return false;
        var changed = result.data.status !== receipt.status;
        receipt.status = result.data.status;
        receipt.state = result.data.state;
        if (changed) {
          var old = body.querySelector('.ci-receipt');
          if (old) old.replaceWith(renderReceipt());
          announce('Request ' + receipt.intent_id.slice(0, 8) + ': ' + receipt.status + '.');
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
    fetch(API + '/capabilities', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok || !/application\/json/.test(res.headers.get('content-type') || '')) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || data.protocol_version !== 1 || typeof data.csrf_token !== 'string' || !data.features) return;
        if (!Array.isArray(data.type_hints)) data.type_hints = [];
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
