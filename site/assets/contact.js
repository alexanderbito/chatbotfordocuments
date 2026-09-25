// A mailto link rather than a form endpoint: there is no mail service wired up yet,
// and a form that silently discards messages is worse than no form at all.
document.getElementById('contactForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var get = function (id) { return document.getElementById(id).value.trim(); };
  var topic = get('ctopic');
  var subject = topic + (get('ccompany') ? ' — ' + get('ccompany') : '');
  var body = [
    'Name: ' + get('cname'),
    'Company: ' + (get('ccompany') || '(not given)'),
    'Email: ' + get('cemail'),
    '',
    get('cmsg'),
  ].join('\n');
  window.location.href = 'mailto:hello@botclarify.com'
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(body);
});
