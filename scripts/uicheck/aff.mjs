import { chromium } from 'playwright';

/**
 * The affiliate screens, and the automatic-renewal card beside them.
 *
 * What is being defended here is arithmetic the customer can see. An affiliate
 * who reads one figure on their page and is paid another writes an email that
 * takes a day to answer, so both screens are checked against the same numbers,
 * and the rules that decide whether a payout may be recorded at all are checked
 * on a row that must NOT offer it.
 */

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const problems = [];
const signedIn = () => {
  try { localStorage.setItem('botclarify_token', 't'); localStorage.setItem('botclarify_org', 'o1'); } catch {}
};

// ---------- the affiliate's own page ----------
{
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', (e) => problems.push('admin JS: ' + e.message));
  await pg.addInitScript(signedIn);
  await pg.goto('http://localhost:4601/admin.html#affiliate', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);

  const txt = await pg.locator('#view-affiliate').innerText();
  for (const need of ['20%', '30%', 'botclarify.com/?ref=mk7qtv3n', 'Globex', 'Initech']) {
    if (!txt.includes(need)) problems.push(`affiliate: thiếu "${need}"`);
  }
  // The three states of money must each be shown, and be the figures the
  // server sent — not a total the page worked out for itself.
  // money() drops a trailing .00, so $78 and not $78.00.
  for (const need of ['$233.10', '$45.60', '$78']) {
    if (!txt.includes(need)) problems.push(`affiliate: thiếu số tiền ${need}`);
  }
  // Held, ready and paid must look different from one another.
  for (const need of ['Held until', 'Ready', 'Paid to you']) {
    if (!txt.includes(need)) problems.push(`affiliate: không phân biệt trạng thái "${need}"`);
  }
  // A company that has not paid yet must not be shown as paying.
  if (!/Not yet/.test(txt)) problems.push('affiliate: công ty chưa trả tiền vẫn hiện là đang trả');
  // Somewhere to be paid.
  const paypal = await pg.locator('#affPaypal').inputValue();
  if (paypal !== 'alex@example.com') problems.push(`affiliate: ô PayPal chứa "${paypal}"`);
  // The link must be copyable as text, not only as a picture of a link.
  const link = await pg.locator('#affLink').textContent();
  if (!/^https:\/\/botclarify\.com\/\?ref=/.test(link || '')) problems.push(`affiliate: link sai — "${link}"`);

  await pg.screenshot({ path: './aff-affiliate.png' });

  // An affiliate whose own plan has lapsed keeps their ledger but stops
  // earning. That has to be said at the top of the page, not discovered from a
  // ledger that quietly stopped growing.
  await pg.route('**/affiliate', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ json: { ...body, eligible: false } });
  });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(700);
  const lapsed = await pg.locator('#view-affiliate').innerText();
  if (!/commissions are paused/i.test(lapsed)) problems.push('affiliate: gói hết hạn mà không báo tạm dừng hoa hồng');
  // ...and the ledger is still theirs to read.
  if (!lapsed.includes('$233.10')) problems.push('affiliate: gói hết hạn thì mất luôn sổ hoa hồng');
  await pg.close();
}

// ---------- the subscription card on the billing tab ----------
{
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', (e) => problems.push('billing JS: ' + e.message));
  await pg.addInitScript(signedIn);
  await pg.goto('http://localhost:4601/admin.html#billing', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);

  const txt = await pg.locator('#view-billing').innerText();
  if (!/Renewing automatically/.test(txt)) problems.push('billing: không nói gói đang tự gia hạn');
  if (!/\$19 every month/.test(txt)) problems.push('billing: không ghi rõ mỗi kỳ thu bao nhiêu');
  if (!/Stop renewing/.test(txt)) problems.push('billing: không có cách dừng gia hạn');
  // Cancelling must not read like losing the time already paid for.
  if (!/end of the period you have paid for/.test(txt)) {
    problems.push('billing: không nói rõ huỷ vẫn dùng hết kỳ đã trả');
  }
  await pg.close();
}

// ---------- the system administrator's view ----------
{
  const pg = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', (e) => problems.push('sysadmin JS: ' + e.message));
  await pg.addInitScript(signedIn);
  await pg.goto('http://localhost:4601/sysadmin.html#affiliates', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);

  const txt = await pg.locator('#view-affiliates').innerText();
  // The same figures as the affiliate's own page. A disagreement here is an
  // argument about money later.
  for (const need of ['$233.10', '$45.60', '$78', 'mk7qtv3n', 'Alex Morgan']) {
    if (!txt.includes(need)) problems.push(`sysadmin: thiếu "${need}"`);
  }
  if (!/20% \/ 30%/.test(txt)) problems.push('sysadmin: không ghi tỷ lệ hoa hồng');
  if (!/not given/.test(txt)) problems.push('sysadmin: không cảnh báo affiliate chưa có địa chỉ nhận tiền');
  if (!/Suspended/.test(txt)) problems.push('sysadmin: không phân biệt affiliate bị tạm dừng');

  // Exactly one payout button: the other affiliate has no PayPal address and
  // nothing payable, and must not be offered one.
  const pay = await pg.locator('[data-pay]').count();
  if (pay !== 1) problems.push(`sysadmin: có ${pay} nút ghi nhận chi trả, đáng lẽ 1`);

  // The dialog has to say plainly that it moves no money, because it does not.
  if (pay === 1) {
    await pg.locator('[data-pay]').first().click();
    await pg.waitForTimeout(400);
    const dlg = await pg.locator('.modal-backdrop .modal-body').last().innerText();
    if (!/already sent/.test(dlg)) problems.push('sysadmin: hộp thoại không nói rõ đây chỉ là ghi nhận');
    if (!dlg.includes('$233.10')) problems.push('sysadmin: hộp thoại không hiện số tiền sẽ ghi nhận');
    if (!dlg.includes('alex@example.com')) problems.push('sysadmin: hộp thoại không hiện địa chỉ nhận tiền');
    // The amount must not be editable: it comes from the commissions.
    const editable = await pg.locator('.modal-backdrop input[type="number"]').count();
    if (editable) problems.push('sysadmin: số tiền chi trả lại sửa được');
    await pg.screenshot({ path: './aff-payout.png' });
  }
  await pg.close();
}

// ---------- the public page ----------
{
  const pg = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', (e) => problems.push('site JS: ' + e.message));
  await pg.goto('http://localhost:4600/affiliate.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(400);

  const txt = await pg.locator('body').innerText();
  for (const need of ['20%', '30%', 'PayPal']) {
    if (!txt.includes(need)) problems.push(`site/affiliate: thiếu "${need}"`);
  }
  if (!/(30 days|[Tt]hirty days)/.test(txt)) problems.push('site/affiliate: không nói rõ thời gian giữ tiền');
  // The rates on the public page and in the console are the same two numbers
  // written in two places, which is exactly how they come to disagree.
  if (!/\$15\.80/.test(txt) || !/\$233\.10/.test(txt)) {
    problems.push('site/affiliate: ví dụ tính tiền không khớp với tỷ lệ');
  }
  if (!/cannot refer yourself/i.test(txt)) problems.push('site/affiliate: không nêu quy tắc tự giới thiệu');

  // Reachable from the rest of the site, in both directions.
  const back = await pg.locator('a[href="/#pricing"], a[href="/"]').count();
  if (!back) problems.push('site/affiliate: không có đường về trang chính');
  const home = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  await home.goto('http://localhost:4600/', { waitUntil: 'networkidle' });
  if (!(await home.locator('a[href="/affiliate.html"]').count())) {
    problems.push('site: trang chủ không dẫn tới trang affiliate');
  }
  await home.close();
  await pg.close();
}

// ---------- a referral code has to survive the journey ----------
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.goto('http://localhost:4600/?ref=mk7qtv3n', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(400);
  // Every link into the application must carry the code, or a visitor who
  // reads the pricing section first arrives unattributed.
  const hrefs = await pg.locator('a[href*="app.botclarify.com"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('href')));
  const missing = hrefs.filter((h) => !/[?&]ref=mk7qtv3n/.test(h));
  if (!hrefs.length) problems.push('site: không có liên kết nào sang ứng dụng');
  if (missing.length) problems.push(`site: ${missing.length} liên kết mất mã giới thiệu — ${missing[0]}`);

  // ...and after moving to another page of the site, in this tab...
  await pg.goto('http://localhost:4600/security.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(300);
  const h2 = await pg.locator('a[href*="app.botclarify.com"]').first().getAttribute('href');
  if (!/[?&]ref=mk7qtv3n/.test(h2 || '')) problems.push(`site: sang trang khác là mất mã — "${h2}"`);

  // ...and in a NEW tab, because people open the pricing page in one. This is
  // the case sessionStorage silently loses.
  const p3 = await ctx.newPage();
  await p3.goto('http://localhost:4600/contact.html', { waitUntil: 'networkidle' });
  await p3.waitForTimeout(300);
  const h3 = await p3.locator('a[href*="app.botclarify.com"]').first().getAttribute('href');
  if (!/[?&]ref=mk7qtv3n/.test(h3 || '')) problems.push(`site: mở tab mới là mất mã — "${h3}"`);

  // An expired code must not follow the visitor around for ever.
  await p3.evaluate(() => {
    localStorage.setItem('botclarify_ref', JSON.stringify({ c: 'mk7qtv3n', e: Date.now() - 1000 }));
  });
  await p3.goto('http://localhost:4600/contact.html', { waitUntil: 'networkidle' });
  await p3.waitForTimeout(300);
  const h4 = await p3.locator('a[href*="app.botclarify.com"]').first().getAttribute('href');
  if (/[?&]ref=/.test(h4 || '')) problems.push(`site: mã đã hết hạn vẫn được dùng — "${h4}"`);
  await ctx.close();
}

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
