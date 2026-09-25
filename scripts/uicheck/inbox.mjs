import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];

const pg = await b.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
pg.on('pageerror', e => problems.push('sysadmin JS: ' + e.message));
// Any alert() means injected markup executed. Nothing in this page should ever
// raise one, so a dialog at all is a failure.
pg.on('dialog', async d => { problems.push(`CHẠY MÃ CHÈN VÀO: ${d.type()} "${d.message()}"`); await d.dismiss(); });
await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
await pg.goto('http://localhost:4601/sysadmin.html#messages', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1000);

// The unread badge.
const badge = await pg.evaluate(() => {
  const item = document.querySelector('.nav-item[data-view="messages"]');
  return { exists: !!item, count: item?.querySelector('.count')?.textContent || null };
});
if (!badge.exists) problems.push('không có mục Messages trong menu');
if (badge.count !== '2') problems.push(`huy hiệu tin chưa đọc hiện "${badge.count}", lẽ ra "2"`);

const list = await pg.locator('#view-messages').innerText();
for (const need of ['Jane Smith', 'jane@acme.com', 'Acme Inc.', 'Unread']) {
  if (!list.includes(need)) problems.push(`danh sách thiếu "${need}"`);
}

// The hostile row must appear as text, with no elements built from it.
const injected = await pg.evaluate(() => ({
  imgs: document.querySelectorAll('#view-messages img[src="x"]').length,
  scripts: document.querySelectorAll('#view-messages script').length,
  bold: document.querySelectorAll('#view-messages b').length,
  shown: document.querySelector('#view-messages')?.innerText.includes('<img src=x'),
}));
if (injected.imgs) problems.push('thẻ img từ tên người gửi được dựng thành phần tử');
if (injected.scripts) problems.push('thẻ script từ dữ liệu người gửi được dựng thành phần tử');
if (injected.bold) problems.push('thẻ b từ dữ liệu người gửi được dựng thành phần tử');
if (!injected.shown) problems.push('tên chứa mã không được hiện ra dạng chữ');
await pg.screenshot({ path: './inbox-list.png' });

// Open the first message.
await pg.locator('[data-open]').first().click();
await pg.waitForTimeout(500);
const dlg = await pg.locator('.modal-backdrop .modal-body').last().innerText();
for (const need of ['jane@acme.com', '400 policy documents', 'Reply by email', 'Archive', 'Mark as spam']) {
  if (!dlg.includes(need)) problems.push(`hộp thoại thiếu "${need}"`);
}
// Line breaks the sender typed must survive.
const wrapped = await pg.evaluate(() => getComputedStyle(document.querySelector('.msg-body')).whiteSpace);
if (!/pre-wrap/.test(wrapped)) problems.push(`nội dung tin nhắn white-space=${wrapped}, mất xuống dòng`);
// One closing button, not two.
const footButtons = await pg.locator('.modal-backdrop .modal-foot button').count();
if (footButtons !== 1) problems.push(`chân hộp thoại có ${footButtons} nút, lẽ ra 1`);
// The reply link must carry the sender's address.
const mailto = await pg.locator('.modal-backdrop a[href^="mailto:"]').first().getAttribute('href');
if (!mailto?.includes('jane%40acme.com') && !mailto?.includes('jane@acme.com')) problems.push(`liên kết trả lời sai: ${mailto}`);
await pg.screenshot({ path: './inbox-open.png' });

// Opening a message marks it read, so the badge must drop.
await pg.waitForTimeout(600);
const after = await pg.evaluate(() => document.querySelector('.nav-item[data-view="messages"] .count')?.textContent || '0');
if (after === '2') problems.push('mở tin nhắn rồi mà huy hiệu vẫn là 2');

// Open the hostile message directly and confirm nothing executes there either.
await pg.locator('.modal-backdrop [data-x]').first().click();
await pg.waitForTimeout(300);
await pg.locator('[data-open]').nth(1).click();
await pg.waitForTimeout(500);
const dlg2 = await pg.evaluate(() => ({
  text: document.querySelector('.msg-body')?.innerText || '',
  elems: document.querySelectorAll('.msg-body *').length,
}));
if (!dlg2.text.includes('<script>')) problems.push('nội dung chứa mã không hiện ra dạng chữ');
if (dlg2.elems) problems.push(`thân tin nhắn dựng ra ${dlg2.elems} phần tử con từ dữ liệu người gửi`);
await pg.close();

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
