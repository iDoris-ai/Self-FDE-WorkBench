/* ============================================================
   Self-FDE WorkBench — bilingual toggle
   ------------------------------------------------------------
   English is the inline default (so default visitors get no
   flash of unstyled/wrong language). Chinese lives in `data-zh`
   attributes and is swapped in on demand.

   Markup contract:
     <p data-zh="中文">English</p>          → innerHTML swap
     <text data-zh="中文">English</text>    → textContent swap (SVG)
     <title data-zh="中文标题">English</title>
     <meta name="description" content="…" data-zh="中文描述">

   Choice is persisted in localStorage and mirrored to <html lang>.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'sfw-lang';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var EN = new WeakMap(); // element → original English content

  function nodes() {
    return document.querySelectorAll('[data-zh]');
  }

  // Cache the English original before the first swap, so toggling back
  // is lossless and doesn't depend on a second set of attributes.
  function cacheEnglish() {
    nodes().forEach(function (el) {
      if (EN.has(el)) return;
      if (el.tagName === 'META') EN.set(el, el.getAttribute('content'));
      else if (el.namespaceURI === SVG_NS) EN.set(el, el.textContent);
      else EN.set(el, el.innerHTML);
    });
  }

  function apply(lang) {
    var zh = lang === 'zh';

    nodes().forEach(function (el) {
      var next = zh ? el.getAttribute('data-zh') : EN.get(el);
      if (next == null) return;
      if (el.tagName === 'META') el.setAttribute('content', next);
      else if (el.namespaceURI === SVG_NS) el.textContent = next;
      else el.innerHTML = next;
    });

    document.documentElement.lang = zh ? 'zh-CN' : 'en';
    document.documentElement.setAttribute('data-lang', zh ? 'zh' : 'en');

    document.querySelectorAll('.lang-btn').forEach(function (btn) {
      var on = btn.dataset.lang === (zh ? 'zh' : 'en');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    try { localStorage.setItem(KEY, zh ? 'zh' : 'en'); } catch (e) { /* private mode */ }
  }

  function initial() {
    // ?lang=zh wins over everything, so a link can pin its language.
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'zh' || q === 'en') return q;

    var saved;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (saved === 'zh' || saved === 'en') return saved;

    // No stored choice: default to English, per spec — but a visitor whose
    // browser is Chinese almost certainly wants Chinese.
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  }

  function boot() {
    cacheEnglish();
    apply(initial());

    document.querySelectorAll('.lang-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { apply(btn.dataset.lang); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
