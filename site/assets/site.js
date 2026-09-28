/* Shared behaviour for every page: the mobile menu, and the current year. */
(function () {
  var head = document.querySelector('.site-head');
  var toggle = document.querySelector('.nav-toggle');
  if (head && toggle) {
    toggle.addEventListener('click', function () {
      var open = head.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Following a link should close the menu, otherwise it stays open over the
    // section the reader just jumped to.
    head.querySelectorAll('.nav a').forEach(function (a) {
      a.addEventListener('click', function () { head.classList.remove('open'); });
    });
  }
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  /**
   * Carry a referral code across to the application.
   *
   * The link lands here (botclarify.com/?ref=CODE) but the sign-up form lives
   * on app.botclarify.com, a different origin — so nothing is shared
   * automatically. The code is remembered here and appended to every link that
   * crosses over, and the app stores it again on arrival for a visitor who
   * reads a few pages before signing up.
   */
  (function () {
    var KEY = 'botclarify_ref';
    var WINDOW_DAYS = 30;

    function remember(c) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ c: c, e: Date.now() + WINDOW_DAYS * 864e5 }));
      } catch (e) {}
    }
    function recall() {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return '';
        var v = JSON.parse(raw);
        // An expired code is removed rather than ignored, so it cannot
        // reappear if the clock or the window ever changes.
        if (!v || !v.c || !v.e || v.e < Date.now()) { localStorage.removeItem(KEY); return ''; }
        return String(v.c);
      } catch (e) { return ''; }
    }

    var code = new URLSearchParams(location.search).get('ref');
    code = (code || '').trim().toLowerCase();
    if (code && !/^[a-z0-9-]{4,32}$/.test(code)) code = '';
    // Stored rather than kept in the tab: people open the pricing page in a new
    // tab, and sessionStorage does not follow them there. Thirty days is the
    // same window the affiliate is told about.
    if (code) remember(code);
    if (!code) code = recall();
    if (!code || !/^[a-z0-9-]{4,32}$/.test(code)) return;

    document.querySelectorAll('a[href*="app.botclarify.com"]').forEach(function (a) {
      try {
        var url = new URL(a.href);
        if (!url.searchParams.has('ref')) {
          url.searchParams.set('ref', code);
          a.href = url.toString();
        }
      } catch (e) {}
    });
  })();

  // Monthly / yearly prices. Both are already in the page; this only moves the
  // flag that decides which of the two the stylesheet shows, so there is no
  // moment where a price is missing and nothing here can print a wrong number.
  var plans = document.querySelector('.plans[data-cycle]');
  var buttons = document.querySelectorAll('.cycle-toggle [data-cycle]');
  if (plans && buttons.length) {
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        plans.setAttribute('data-cycle', btn.dataset.cycle);
        buttons.forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
      });
    });
  }
})();
