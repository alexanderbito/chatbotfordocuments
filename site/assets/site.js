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
})();
