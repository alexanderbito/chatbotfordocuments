import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];

async function shot(pg, name) { await pg.screenshot({ path: `./${name}.png`, fullPage: false }); }

// ---- app pricing page ----
{
  const pg = await b.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('pricing JS: ' + e.message));
  await pg.goto('http://localhost:4601/pricing.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(600);

  const sw = await pg.locator('#cycleSwitch').isVisible();
  if (!sw) problems.push('pricing: nút chuyển chu kỳ không hiện');
  const saveTxt = await pg.locator('#cycleSave').textContent();
  if (!/18/.test(saveTxt || '')) problems.push(`pricing: badge tiết kiệm ghi "${saveTxt}"`);

  const monthly = await pg.locator('.plan-card').allInnerTexts();
  await shot(pg, 'cyc-pricing-monthly');

  await pg.click('#cycleSwitch [data-cycle="yearly"]');
  await pg.waitForTimeout(350);
  const yearly = await pg.locator('.plan-card').allInnerTexts();
  await shot(pg, 'cyc-pricing-yearly');

  // Every paid plan's price must actually change, and the year price must be
  // strictly less than twelve months of the monthly price.
  const pairs = [['Professional', 19, 187], ['Business', 79, 777]];
  for (const [name, m, y] of pairs) {
    const mCard = monthly.find(t => t.includes(name)) || '';
    const yCard = yearly.find(t => t.includes(name)) || '';
    if (!mCard.includes('$' + m)) problems.push(`pricing: ${name} tháng không thấy $${m}`);
    if (!yCard.includes('$' + y)) problems.push(`pricing: ${name} năm không thấy $${y}`);
    if (!/\/year/.test(yCard)) problems.push(`pricing: ${name} năm không ghi /year`);
    if (!yCard.includes('18%')) problems.push(`pricing: ${name} năm không ghi 18%`);
    if (y >= m * 12) problems.push(`pricing: ${name} giá năm không rẻ hơn 12 tháng`);
  }
  // aria-pressed must follow the visible state, for a screen reader.
  const pressed = await pg.locator('#cycleSwitch [aria-pressed="true"]').getAttribute('data-cycle');
  if (pressed !== 'yearly') problems.push(`pricing: aria-pressed còn ở "${pressed}"`);

  // The free plan must not grow a yearly price.
  const freeCard = yearly.find(t => t.includes('Free trial')) || '';
  if (/\/year/.test(freeCard)) problems.push('pricing: gói dùng thử lại có giá năm');

  await pg.close();
}

// ---- marketing site ----
{
  const pg = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('site JS: ' + e.message));
  await pg.goto('http://localhost:4600/#pricing', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(500);
  await pg.locator('#pricing').scrollIntoViewIfNeeded();
  await pg.waitForTimeout(300);

  const mTxt = await pg.locator('.plans').innerText();
  if (!/\$19/.test(mTxt) || /\$187/.test(mTxt)) problems.push('site: khổ tháng không đúng');
  await shot(pg, 'cyc-site-monthly');

  await pg.click('.cycle-toggle [data-cycle="yearly"]');
  await pg.waitForTimeout(300);
  const yTxt = await pg.locator('.plans').innerText();
  for (const need of ['$187', '$777', '$228', '$948', 'save 18%']) {
    if (!yTxt.includes(need)) problems.push(`site: khổ năm thiếu "${need}"`);
  }
  if (/\$19\s*\/month/.test(yTxt)) problems.push('site: khổ năm vẫn còn giá tháng');
  await shot(pg, 'cyc-site-yearly');

  // Without JavaScript the monthly price must still be the one that shows.
  const noJs = await b.newContext({ javaScriptEnabled: false });
  const p2 = await noJs.newPage();
  await p2.goto('http://localhost:4600/', { waitUntil: 'load' });
  const nTxt = await p2.locator('.plans').innerText();
  if (!/\$19/.test(nTxt)) problems.push('site: tắt JS thì mất giá tháng');
  if (/\$187/.test(nTxt)) problems.push('site: tắt JS thì hiện cả hai giá cùng lúc');
  await noJs.close();
  await pg.close();
}

// ---- admin billing tab ----
{
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  pg.on('pageerror', e => problems.push('admin JS: ' + e.message));
  await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
  await pg.goto('http://localhost:4601/admin.html#billing', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(800);
  const txt = await pg.locator('#view-billing').innerText();
  if (!/\/year/.test(txt)) problems.push('admin: thẻ gói hiện tại không ghi /year cho khách trả theo năm');
  if (!/\$187/.test(txt)) problems.push('admin: không thấy $187');
  if (!/Yearly/.test(txt)) problems.push('admin: lịch sử thanh toán không có cột chu kỳ');
  await shot(pg, 'cyc-admin');

  // The upgrade dialog must offer both cycles and total the chosen one.
  const buy = pg.locator('[data-buy]').first();
  if (await buy.count()) {
    await buy.click();
    await pg.waitForTimeout(400);
    const dlg = await pg.locator('.modal-backdrop .modal-body').last().innerText();
    if (!/Yearly/.test(dlg)) problems.push('admin: hộp thoại nâng cấp không có lựa chọn năm');
    // The larger charge must never be the one pre-selected: an admin who
    // clicks straight through should be billed for a month, not a year.
    if (!/Total for 1 month/.test(dlg)) problems.push('admin: hộp thoại mặc định KHÔNG phải theo tháng');
    const preChecked = await pg.locator('input[name="cyc"]:checked').getAttribute('value');
    if (preChecked !== 'monthly') problems.push(`admin: chu kỳ mặc định là "${preChecked}"`);
    await pg.click('[data-cyc="yearly"]');
    await pg.waitForTimeout(250);
    const dlg2 = await pg.locator('.modal-backdrop .modal-body').last().innerText();
    if (!/Total for 12 months/.test(dlg2)) problems.push('admin: đổi sang năm mà tổng không đổi');
    await shot(pg, 'cyc-admin-modal');
    // Switching the cycle must not clear the payment method.
    const provSel = await pg.locator('.pay-method[data-prov].sel').count();
    if (provSel !== 1) problems.push(`admin: đổi chu kỳ làm mất lựa chọn phương thức (còn ${provSel})`);

    // The radio must sit beside its label, not above it, and must be orange.
    const radio = await pg.evaluate(() => {
      const row = document.querySelector('.pay-method[data-cyc]');
      const inp = row.querySelector('input'), who = row.querySelector('.who');
      const a = inp.getBoundingClientRect(), w = who.getBoundingClientRect();
      return { flex: getComputedStyle(row).display, accent: getComputedStyle(inp).accentColor,
               sameLine: a.top < w.bottom && w.top < a.bottom };
    });
    if (radio.flex !== 'flex') problems.push(`admin: hàng chọn chu kỳ display=${radio.flex}`);
    if (!radio.sameLine) problems.push('admin: nút radio nằm trên dòng riêng, không cùng hàng với nhãn');
    if (!/210, ?68, ?10/.test(radio.accent)) problems.push(`admin: radio còn màu mặc định ${radio.accent}`);
  } else problems.push('admin: không có nút nâng cấp gói');
  await pg.close();
}

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
