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
