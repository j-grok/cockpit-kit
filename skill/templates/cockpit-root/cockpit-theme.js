/*
 * cockpit-theme.js — Light / Dark / System theme preference.
 *
 * Load this same-origin file synchronously in <head>, right after the
 * cockpit.css <link> and without defer/async:
 *
 *   <link rel="stylesheet" href="./cockpit.css">
 *   <script src="./cockpit-theme.js"></script>
 *
 * Because the script blocks parsing, it sets <html data-theme> before the
 * body is painted, so a stored choice never flashes the wrong palette.
 *
 * - Preference lives in localStorage under "cockpit-theme": "light" or
 *   "dark". System is the default and is stored by removing the key.
 * - <html data-theme> is "system", "light", or "dark". cockpit.css maps
 *   "light" and "dark" to fixed palettes; anything else follows
 *   prefers-color-scheme, which the browser re-evaluates live when the
 *   OS appearance changes. Without JavaScript the attribute is absent and
 *   the media query alone decides.
 * - <meta name="color-scheme"> is kept in sync so form controls and
 *   scrollbars match. <meta name="theme-color">, when present, follows --bg.
 * - Any element with [data-cockpit-theme-switch] containing radio inputs
 *   named "cockpit-theme" becomes the switcher. It ships with the `hidden`
 *   attribute and is revealed here, so no-JS visitors never see a control
 *   that cannot work.
 *
 * No network access, no dependencies, no cookies.
 */
(function () {
  'use strict';
  var KEY = 'cockpit-theme';
  var CHOICES = ['system', 'light', 'dark'];
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var value = window.localStorage.getItem(KEY);
      return CHOICES.indexOf(value) > 0 ? value : 'system';
    } catch (error) {
      return 'system';
    }
  }

  function write(choice) {
    try {
      if (choice === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch (error) {
      /* Storage unavailable (private mode, file://): apply for this page only. */
    }
  }

  function resolved(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    return media && media.matches ? 'dark' : 'light';
  }

  function setMeta(name, content) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (meta && content) meta.setAttribute('content', content);
  }

  function syncSwitches(choice) {
    var inputs = document.querySelectorAll('[data-cockpit-theme-switch] input[name="cockpit-theme"]');
    for (var i = 0; i < inputs.length; i += 1) inputs[i].checked = inputs[i].value === choice;
    var notes = document.querySelectorAll('[data-cockpit-theme-switch] [data-cockpit-theme-resolved]');
    for (var j = 0; j < notes.length; j += 1) notes[j].textContent = choice === 'system' ? 'System is using ' + resolved(choice) : '';
  }

  function apply(choice) {
    root.setAttribute('data-theme', choice);
    setMeta('color-scheme', choice === 'system' ? 'light dark' : choice);
    var bg = window.getComputedStyle ? window.getComputedStyle(root).getPropertyValue('--bg').trim() : '';
    setMeta('theme-color', bg);
    syncSwitches(choice);
  }

  apply(read());

  if (media) {
    var onChange = function () { if (read() === 'system') apply('system'); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  window.addEventListener('storage', function (event) {
    if (event.key === KEY || event.key === null) apply(read());
  });

  function wire() {
    var switches = document.querySelectorAll('[data-cockpit-theme-switch]');
    for (var i = 0; i < switches.length; i += 1) {
      switches[i].hidden = false;
      switches[i].addEventListener('change', function (event) {
        var target = event.target;
        if (!target || target.name !== 'cockpit-theme' || CHOICES.indexOf(target.value) < 0) return;
        write(target.value);
        apply(target.value);
      });
    }
    apply(read());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
}());
