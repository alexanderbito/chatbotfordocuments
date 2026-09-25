/**
 * The contact form posts to the application's API.
 *
 * The site is served from botclarify.com and the API lives on
 * app.botclarify.com, so this is a cross-origin POST — the endpoint answers the
 * preflight and names this origin explicitly rather than allowing any.
 *
 * Written as a plain script with no build step and no imports, because the
 * page's Content-Security-Policy allows scripts only from this origin.
 */
(function () {
  var API = 'https://app.botclarify.com';

  // Running the site locally (or from a preview) should talk to a local API
  // rather than to production, so nothing typed into a test form lands in the
  // real inbox.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    API = location.protocol + '//' + location.hostname + ':3000';
  }

  var form = document.getElementById('contactForm');
  if (!form) return;

  var note = document.getElementById('cnote');
  var button = document.getElementById('csend');
  var fields = {
    name: document.getElementById('cname'),
    company: document.getElementById('ccompany'),
    email: document.getElementById('cemail'),
    topic: document.getElementById('ctopic'),
    message: document.getElementById('cmsg'),
    website: document.getElementById('cwebsite'),
  };

  function say(kind, text) {
    note.className = 'form-note ' + kind;
    note.textContent = text;
    note.hidden = false;
  }

  function markInvalid(el) {
    if (!el) return;
    el.setAttribute('aria-invalid', 'true');
    el.focus();
  }

  function clearInvalid() {
    ['name', 'email', 'message'].forEach(function (k) {
      if (fields[k]) fields[k].removeAttribute('aria-invalid');
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearInvalid();

    var name = (fields.name.value || '').trim();
    var email = (fields.email.value || '').trim();
    var message = (fields.message.value || '').trim();

    // Checked here so an obvious slip is caught without a round trip. The
    // server checks the same things again — this is a convenience, not a
    // control, and anything that matters is enforced there.
    if (!name) { say('err', 'Please tell us your name.'); return markInvalid(fields.name); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say('err', 'Please check the email address.'); return markInvalid(fields.email); }
    if (message.length < 10) { say('err', 'Please tell us a little more — at least a sentence.'); return markInvalid(fields.message); }

    var original = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending…';
    note.hidden = true;

    // The chosen topic is not a column of its own; it belongs to the message
    // and reads naturally at the top of it.
    var topic = fields.topic ? fields.topic.value : '';
    var body = topic ? topic + '\n\n' + message : message;

    fetch(API + '/public/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        email: email,
        company: (fields.company.value || '').trim(),
        message: body,
        website: fields.website ? fields.website.value : '',
      }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (r) {
        // Both signals are checked. The server sends its refusals with a 4xx or
        // 5xx status, but a body carrying an "error" is a refusal whatever the
        // status says — and a proxy that rewrites a status to 200 would
        // otherwise turn a rejected message into a thank-you.
        if (!r.ok || r.data.error) throw new Error(r.data.error || 'We could not send your message.');
        form.reset();
        say('ok', 'Thank you — your message is with us. We reply by email, usually within one working day.');
      })
      .catch(function (err) {
        // A network failure and a rejected request look the same to the person
        // filling the form, and in both cases the useful next step is the same.
        say('err', (err.message || 'Something went wrong.') + ' You can also write to hello@botclarify.com.');
      })
      .then(function () {
        button.disabled = false;
        button.textContent = original;
      });
  });
})();
