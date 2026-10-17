import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const templateRoot = path.resolve(import.meta.dirname, '..', 'skill', 'templates', 'cockpit-root');
const css = fs.readFileSync(path.join(templateRoot, 'cockpit.css'), 'utf8');
const themeScript = fs.readFileSync(path.join(templateRoot, 'cockpit-theme.js'), 'utf8');
const pages = ['index.html', 'design-system.html', 'inbox/index.html', 'search/index.html'];

function blockBody(source, selectorPattern) {
  const match = selectorPattern.exec(source);
  assert.ok(match, `missing CSS block ${selectorPattern}`);
  const start = match.index + match[0].length;
  const end = source.indexOf('}', start);
  return source.slice(start, end);
}

function declarations(body) {
  const out = new Map();
  for (const match of body.matchAll(/(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/gi)) out.set(match[1], match[2].trim());
  return out;
}

function themeBlocks(source) {
  const light = declarations(blockBody(source, /:root,\s*:root\[data-theme="light"\]\s*\{/));
  const dark = declarations(blockBody(source, /(?<![:\w-]\s*)^:root\[data-theme="dark"\]\s*\{/m));
  const media = declarations(blockBody(source, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/));
  return { light, dark, media };
}

function luminance(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = [...value].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('starter pages load the theme script in head before first paint', () => {
  for (const rel of pages) {
    const html = fs.readFileSync(path.join(templateRoot, rel), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    const prefix = rel.includes('/') ? '../' : './';
    const script = head.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/);
    assert.ok(script, `${rel}: theme script missing from <head>`);
    assert.equal(script[1], `${prefix}cockpit-theme.js`, `${rel}: theme script must be same-origin and depth-correct`);
    assert.doesNotMatch(script[0], /\b(defer|async|type="module")\b/, `${rel}: theme script must run synchronously`);
    assert.ok(head.indexOf(`href="${prefix}cockpit.css"`) < head.indexOf(script[0]), `${rel}: theme script must follow the stylesheet`);
    assert.match(head, /<meta name="color-scheme" content="light dark">/, `${rel}: color-scheme meta missing`);
  }
});

test('starter pages render an accessible theme switcher inside the nav', () => {
  for (const rel of pages) {
    const html = fs.readFileSync(path.join(templateRoot, rel), 'utf8');
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    const switcher = nav.match(/<fieldset class="theme-switch" data-cockpit-theme-switch hidden>([\s\S]*?)<\/fieldset>/);
    assert.ok(switcher, `${rel}: switcher missing from nav`);
    assert.match(switcher[1], /<legend>Theme<\/legend>/, `${rel}: switcher needs a legend`);
    const values = [...switcher[1].matchAll(/<label title="([A-Za-z]+)"><input type="radio" name="cockpit-theme" value="([a-z]+)"( checked)?><span>([A-Za-z]+)<\/span><\/label>/g)];
    assert.deepEqual(values.map((m) => m[2]), ['system', 'light', 'dark'], `${rel}: radio values`);
    assert.deepEqual(values.map((m) => m[4]), ['System', 'Light', 'Dark'], `${rel}: option names`);
    assert.deepEqual(values.map((m) => m[1]), ['System', 'Light', 'Dark'], `${rel}: hover titles match option names`);
    assert.deepEqual(values.map((m) => Boolean(m[3])), [true, false, false], `${rel}: System is the default`);
    assert.match(switcher[1], /<span class="sr-only" data-cockpit-theme-resolved aria-live="polite"><\/span>/, `${rel}: resolved-scheme note must be a polite live region`);
  }
});

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `missing rule ${selector}`);
  return match[1];
}

test('theme switcher is a compact control fixed to the top-right corner', () => {
  const base = rule(css, '.theme-switch');
  assert.match(base, /position:\s*fixed;/);
  assert.match(base, /top:\s*calc\([^;]*env\(safe-area-inset-top/);
  assert.match(base, /right:\s*calc\([^;]*env\(safe-area-inset-right/);
  const z = Number(base.match(/z-index:\s*(\d+)/)?.[1]);
  const intentsCss = fs.readFileSync(path.join(templateRoot, 'cockpit-intents.css'), 'utf8');
  const widgetZ = Math.min(...[...intentsCss.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(z > 0 && z < widgetZ, 'switcher stays below the comments widget so its open panel is never covered');
  assert.match(intentsCss, /max-height:\s*calc\(100dvh - 72px - var\(--cockpit-top-reserve/, 'comments panel keeps clear of the reserved top band');

  const size = Number(css.match(/:root\s*\{\s*--theme-switch-size:\s*(\d+)px/)?.[1]);
  assert.ok(size >= 32, `tap target is ${size}px`);
  assert.match(rule(css, '.theme-switch label span'), /width:\s*var\(--theme-switch-size\);[\s\S]*height:\s*var\(--theme-switch-size\);/);
  assert.match(rule(css, '.theme-switch input:focus-visible + span'), /outline:\s*2px solid var\(--focus\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.theme-switch label span\s*\{\s*transition:\s*none;/);
  assert.match(css, /:root:has\(\.theme-switch:not\(\[hidden\]\)\)\s*\{[^}]*--cockpit-top-reserve:[^}]*--cockpit-right-reserve:/);
  assert.match(css, /nav\.cockpit-nav \.nav-search\s*\{\s*padding-right:\s*var\(--cockpit-right-reserve/, 'narrow screens keep the search field clear of the switcher');
  assert.match(rule(css, '.page'), /padding:/);
  assert.match(css, /\.page\s*\{\s*padding-top:\s*max\(24px, var\(--cockpit-top-reserve/, 'mid widths keep the page column clear of the switcher');
});

test('light and dark token sets define the same variables', () => {
  const { light, dark, media } = themeBlocks(css);
  assert.ok(light.size > 10);
  assert.deepEqual([...dark.keys()].sort(), [...light.keys()].sort());
  assert.deepEqual([...media.entries()].sort(), [...dark.entries()].sort(), 'prefers-color-scheme dark block must mirror [data-theme="dark"]');
  assert.equal(light.get('color-scheme'), 'light');
  assert.equal(dark.get('color-scheme'), 'dark');
});

test('rules outside the token blocks use tokens rather than literal colors', () => {
  const withoutTokens = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^:root[^{]*\{[^}]*\}/gm, '').replace(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root[^{]*\{[^}]*\}\s*\}/, '');
  assert.doesNotMatch(withoutTokens, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});

test('both palettes meet WCAG AA text contrast', () => {
  const { light, dark } = themeBlocks(css);
  for (const [name, tokens] of Object.entries({ light, dark })) {
    for (const fg of ['--ink', '--ink-soft', '--ink-faint', '--accent']) {
      for (const bg of ['--bg', '--surface', '--surface-2']) {
        const ratio = contrast(tokens.get(fg), tokens.get(bg));
        assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.ok(contrast(tokens.get('--accent-ink'), tokens.get('--accent')) >= 4.5, `${name}: --accent-ink on --accent`);
    for (const status of ['reading', 'finished', 'paused', 'toread', 'active', 'draft', 'shipped']) {
      const ratio = contrast(tokens.get(`--status-${status}`), tokens.get(`--status-${status}-bg`));
      assert.ok(ratio >= 4.5, `${name}: status ${status} is ${ratio.toFixed(2)}:1`);
    }
  }
});

function fakeBrowser({ stored, prefersDark = false, storageThrows = false, readyState = 'complete' } = {}) {
  const store = new Map(stored === undefined ? [] : [['cockpit-theme', stored]]);
  const attrs = new Map();
  const meta = (content) => ({ content, setAttribute(key, value) { if (key === 'content') this.content = value; } });
  const metas = { 'color-scheme': meta('light dark'), 'theme-color': meta('#000') };
  const radios = ['system', 'light', 'dark'].map((value) => ({ name: 'cockpit-theme', value, checked: value === 'system' }));
  const note = { textContent: '' };
  const listeners = {};
  const mediaListeners = [];
  const switcher = { hidden: true, addEventListener: (type, fn) => { listeners[`switch:${type}`] = fn; } };
  const media = { matches: prefersDark, addEventListener: (type, fn) => mediaListeners.push(fn) };
  const localStorage = {
    getItem: (key) => { if (storageThrows) throw new Error('denied'); return store.has(key) ? store.get(key) : null; },
    setItem: (key, value) => { if (storageThrows) throw new Error('denied'); store.set(key, String(value)); },
    removeItem: (key) => { if (storageThrows) throw new Error('denied'); store.delete(key); },
  };
  const documentElement = { setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => attrs.get(k) };
  const document = {
    documentElement,
    readyState,
    addEventListener: (type, fn) => { listeners[`doc:${type}`] = fn; },
    querySelector: (selector) => metas[selector.match(/name="([^"]+)"/)?.[1]] ?? null,
    querySelectorAll: (selector) => {
      if (selector.endsWith('input[name="cockpit-theme"]')) return radios;
      if (selector.endsWith('[data-cockpit-theme-resolved]')) return [note];
      if (selector === '[data-cockpit-theme-switch]') return [switcher];
      return [];
    },
  };
  const window = {
    localStorage,
    matchMedia: () => media,
    getComputedStyle: () => ({ getPropertyValue: () => (attrs.get('data-theme') === 'dark' || (attrs.get('data-theme') === 'system' && media.matches) ? ' #0e1013' : ' #ecedef') }),
    addEventListener: (type, fn) => { listeners[`win:${type}`] = fn; },
  };
  const context = vm.createContext({ window, document });
  vm.runInContext(themeScript, context);
  return {
    store, attrs, metas, radios, note, switcher, media, listeners,
    choose(value) { const target = radios.find((r) => r.value === value); target.checked = true; listeners['switch:change']({ target }); },
    osChange(dark) { media.matches = dark; for (const fn of mediaListeners) fn({ matches: dark }); },
  };
}

test('theme script applies stored choice, defaults to system, and survives storage errors', () => {
  assert.equal(fakeBrowser({ stored: 'dark' }).attrs.get('data-theme'), 'dark');
  assert.equal(fakeBrowser({ stored: 'light' }).metas['color-scheme'].content, 'light');
  assert.equal(fakeBrowser().attrs.get('data-theme'), 'system');
  assert.equal(fakeBrowser({ stored: 'purple' }).attrs.get('data-theme'), 'system');
  assert.equal(fakeBrowser({ stored: 'system' }).attrs.get('data-theme'), 'system');
  const blocked = fakeBrowser({ storageThrows: true });
  assert.equal(blocked.attrs.get('data-theme'), 'system');
  blocked.choose('dark');
  assert.equal(blocked.attrs.get('data-theme'), 'dark');
});

test('pinned choice survives OS changes when storage is unavailable', () => {
  for (const pinned of ['light', 'dark']) {
    const browser = fakeBrowser({ storageThrows: true, prefersDark: pinned === 'light' });
    browser.choose(pinned);
    browser.osChange(pinned !== 'dark');
    browser.osChange(pinned === 'dark');
    assert.equal(browser.attrs.get('data-theme'), pinned, `${pinned} must not fall back to system`);
    assert.equal(browser.metas['color-scheme'].content, pinned);
    assert.deepEqual(browser.radios.map((r) => r.checked), ['system', 'light', 'dark'].map((v) => v === pinned));
  }
});

test('theme script reveals the switcher, persists choices, and tracks OS changes', () => {
  const browser = fakeBrowser({ stored: 'light' });
  assert.equal(browser.switcher.hidden, false);
  assert.deepEqual(browser.radios.map((r) => r.checked), [false, true, false]);

  browser.choose('dark');
  assert.equal(browser.store.get('cockpit-theme'), 'dark');
  assert.equal(browser.attrs.get('data-theme'), 'dark');
  assert.equal(browser.metas['color-scheme'].content, 'dark');
  assert.equal(browser.metas['theme-color'].content, '#0e1013');

  browser.choose('system');
  assert.equal(browser.store.has('cockpit-theme'), false);
  assert.equal(browser.metas['color-scheme'].content, 'light dark');
  assert.equal(browser.note.textContent, 'System is using light');
  browser.osChange(true);
  assert.equal(browser.note.textContent, 'System is using dark');
  assert.equal(browser.metas['theme-color'].content, '#0e1013');
});

test('theme script defers switcher wiring until DOMContentLoaded while loading', () => {
  const browser = fakeBrowser({ stored: 'dark', readyState: 'loading' });
  assert.equal(browser.attrs.get('data-theme'), 'dark', 'attribute is set before the body parses');
  assert.equal(browser.switcher.hidden, true);
  browser.listeners['doc:DOMContentLoaded']();
  assert.equal(browser.switcher.hidden, false);
  assert.deepEqual(browser.radios.map((r) => r.checked), [false, false, true]);
});
