import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const problems = [];

// ---------- the API tab in the organization console ----------
{
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('admin JS: ' + e.message));
  await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
  await pg.goto('http://localhost:4601/admin.html#api', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);

  const txt = await pg.locator('#view-api').innerText();
  for (const need of ['API keys', 'Intranet help page', 'bck_a1b2c3', '1,240', '20,000']) {
    if (!txt.includes(need)) problems.push(`tab API thiếu "${need}"`);
  }
  // A revoked key must be listed separately, not mixed in with the live ones.
  if (!txt.includes('Revoked')) problems.push('không có mục khoá đã thu hồi');
  // The full key must never appear in a list.
  const html = await pg.locator('#view-api').innerHTML();
  if (/key_hash/.test(html)) problems.push('bản băm khoá lọt vào trang');
  await pg.screenshot({ path: './api-tab.png' });

  // Creating a key.
  await pg.click('#newKey');
  await pg.waitForTimeout(400);
  const dlg = await pg.locator('.modal-backdrop .modal-body').last().innerText();
  for (const need of ['What is this key for', 'Every folder', 'Only the folders I choose', 'Expires after']) {
    if (!dlg.includes(need)) problems.push(`hộp thoại tạo khoá thiếu "${need}"`);
  }
  // The folder picker stays hidden until the admin asks to narrow the key.
  let pickerHidden = await pg.evaluate(() => document.getElementById('kfolders')?.classList.contains('hidden'));
  if (!pickerHidden) problems.push('danh sách thư mục hiện sẵn dù chưa chọn giới hạn');
  await pg.check('input[name="kscope"][value="some"]');
  await pg.waitForTimeout(250);
  pickerHidden = await pg.evaluate(() => document.getElementById('kfolders')?.classList.contains('hidden'));
  if (pickerHidden) problems.push('chọn giới hạn rồi mà danh sách thư mục không hiện');

  // Creating with no name must be refused before any request goes out.
  await pg.click('.modal-backdrop [data-ok]');
  await pg.waitForTimeout(400);
  if (!(await pg.locator('.modal-backdrop').count())) problems.push('tạo khoá không tên vẫn đóng hộp thoại');

  await pg.fill('#kname', 'Test key');
  await pg.check('input[name="kscope"][value="all"]');
  await pg.click('.modal-backdrop [data-ok]');
  await pg.waitForTimeout(800);

  const reveal = await pg.locator('.modal-backdrop .modal-body').last().innerText();
  if (!/only time this key is shown/i.test(reveal)) problems.push('không cảnh báo khoá chỉ hiện một lần');
  if (!reveal.includes('bck_')) problems.push('không hiện khoá vừa tạo');
  // One closing button: there is nothing to cancel once the key exists.
  const foot = await pg.locator('.modal-backdrop').last().locator('.modal-foot button').count();
  if (foot !== 1) problems.push(`hộp thoại hiện khoá có ${foot} nút, lẽ ra 1`);
  // The key must be selectable by hand when the clipboard is refused.
  const sel = await pg.evaluate(() => getComputedStyle(document.getElementById('newKeyValue')).userSelect);
  if (!/all|text/.test(sel)) problems.push(`khoá không bôi đen được (user-select=${sel})`);
  await pg.screenshot({ path: './api-key-created.png' });
  await pg.close();
}

// ---------- pricing page shows who gets the API ----------
{
  const pg = await b.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('pricing JS: ' + e.message));
  await pg.goto('http://localhost:4601/pricing.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(700);
  const cards = await pg.locator('.plan-card').allInnerTexts();
  const biz = cards.find(t => t.includes('Business')) || '';
  const pro = cards.find(t => t.includes('Professional')) || '';
  if (!/API access — 20,000/.test(biz)) problems.push('gói Business không nêu số lượt API');
  if (!/No API access/.test(pro)) problems.push('gói Professional không nêu là không có API');
  // The "not included" rows must be marked as such, and the right ones.
  const off = await pg.evaluate(() => [...document.querySelectorAll('.plan-card')].map(c =>
    [...c.querySelectorAll('.plan-feats li.off')].map(li => li.innerText.trim())));
  const flat = off.flat().join(' | ');
  if (!/No API access/.test(flat)) problems.push('dòng "No API access" không được đánh dấu là không có');
  if (/API access — 20,000/.test(flat)) problems.push('dòng API của Business bị đánh dấu là không có');
  await pg.screenshot({ path: './api-pricing.png' });
  await pg.close();
}

// ---------- sysadmin can switch the API on per plan ----------
{
  const pg = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('sysadmin JS: ' + e.message));
  await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
  await pg.goto('http://localhost:4601/sysadmin.html#plans', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);
  const head = await pg.evaluate(() => [...document.querySelectorAll('#planTable thead th')].map(th => th.innerText.trim()));
  const firstRow = await pg.evaluate(() => [...(document.querySelectorAll('#planTable tbody tr')[0]?.children || [])].length);
  if (!head.includes('API')) problems.push('bảng Plans thiếu cột API');
  if (firstRow && firstRow !== head.length) problems.push(`bảng Plans lệch cột: ${firstRow} ô / ${head.length} tiêu đề`);
  await pg.close();
}

// ---------- the documentation page ----------
{
  const pg = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('api.html JS: ' + e.message));
  const missing = [];
  pg.on('response', r => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url().split('/').pop()); });
  await pg.goto('http://localhost:4600/api.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(500);
  const txt = await pg.locator('.doc').innerText();
  for (const need of ['POST /v1/chat', 'Authorization: Bearer', 'folder_not_allowed', 'quota_exceeded', 'X-RateLimit-Remaining']) {
    if (!txt.includes(need)) problems.push(`tài liệu thiếu "${need}"`);
  }
  if (missing.length) problems.push(`api.html thiếu tài nguyên: ${missing.join(', ')}`);
  const over = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (over) problems.push('api.html tràn ngang ở khổ máy tính');
  // Every page must link to the docs, and the docs back to the rest.
  const nav = await pg.evaluate(() => [...document.querySelectorAll('.nav a')].map(a => a.getAttribute('href')));
  if (!nav.includes('/api.html')) problems.push('thanh menu không có liên kết tới API');
  await pg.screenshot({ path: './api-docs.png', fullPage: false });

  // Phone width: the code samples must not push the page sideways.
  const mob = await b.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto('http://localhost:4600/api.html', { waitUntil: 'networkidle' });
  await mob.waitForTimeout(400);
  const mOver = await mob.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth + 1) return null;
    for (const el of document.querySelectorAll('.doc *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) return el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 24);
    }
    return '(không xác định)';
  });
  if (mOver) problems.push(`api.html tràn ngang ở khổ 360px — ${mOver}`);
  await mob.close();
  await pg.close();
}

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
