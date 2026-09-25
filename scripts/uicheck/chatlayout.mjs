import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];

for (const [w, h, label] of [[1440, 900, 'desktop'], [1024, 800, 'tablet'], [390, 844, 'phone']]) {
  for (const trial of [false, true]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: w < 800 });
    const pg = await ctx.newPage();
    await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
    await pg.goto('http://localhost:4601/chat.html', { waitUntil: 'networkidle' });
    await pg.waitForTimeout(600);
    if (trial) {
      // Put a real trial banner above the shell, the way trialBanner() does.
      await pg.evaluate(() => {
        document.getElementById('trialBar').innerHTML =
          '<div class="trial-bar warn"><span>!</span><span><b>Trial</b> — 2 days left</span><a class="btn sm primary" href="/pricing.html">Upgrade now</a></div>';
      });
      await pg.waitForTimeout(300);
    }
    const tag = `${label}${trial ? '+banner' : ''}`;

    const r = await pg.evaluate(() => {
      const comp = document.querySelector('.composer').getBoundingClientRect();
      const scroll = document.querySelector('.chat-scroll');
      return {
        compBottom: Math.round(comp.bottom), vh: window.innerHeight,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
        scrollerScrolls: getComputedStyle(scroll).overflowY,
        scrollerH: Math.round(scroll.getBoundingClientRect().height),
        topbarSticky: getComputedStyle(document.querySelector('.topbar')).position,
      };
    });
    if (r.compBottom > r.vh + 1) problems.push(`${tag}: ô nhập nằm dưới màn hình (${r.compBottom} > ${r.vh})`);
    if (r.compBottom < r.vh - 2) problems.push(`${tag}: ô nhập không chạm đáy (${r.compBottom} < ${r.vh})`);
    if (r.pageScrolls) problems.push(`${tag}: cả trang cuộn được thay vì chỉ danh sách tin nhắn`);
    if (r.scrollerH < 100) problems.push(`${tag}: vùng tin nhắn bị bóp còn ${r.scrollerH}px`);

    // Switching views must hide the chat, at every width.
    // Below the breakpoint the menu is a drawer, so it has to be opened first.
    if (await pg.locator('.nav-toggle').isVisible()) {
      await pg.click('.nav-toggle');
      await pg.waitForTimeout(400);
    }
    await pg.click('#appSidebar .nav-item[data-view="history"]');
    await pg.waitForTimeout(500);
    const sw = await pg.evaluate(() => {
      const chat = document.querySelector('.page-section[data-view="chat"]');
      const hist = document.querySelector('.page-section[data-view="history"]');
      return { chatShown: getComputedStyle(chat).display !== 'none',
               histShown: hist ? getComputedStyle(hist).display !== 'none' : null };
    });
    if (sw.chatShown) problems.push(`${tag}: sang History mà khung chat vẫn hiện`);
    if (sw.histShown === false) problems.push(`${tag}: sang History mà khung History không hiện`);
    await ctx.close();
  }
}

// The admin console's long pages must still scroll normally after the body
// became a flex column.
const ctx = await b.newContext({ viewport: { width: 1440, height: 700 } });
const pg = await ctx.newPage();
await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
await pg.goto('http://localhost:4601/admin.html#billing', { waitUntil: 'networkidle' });
await pg.waitForTimeout(900);
const adm = await pg.evaluate(() => ({
  shellH: Math.round(document.querySelector('.shell').getBoundingClientRect().height),
  docH: document.documentElement.scrollHeight,
  vh: window.innerHeight,
  clipped: document.querySelector('.page').getBoundingClientRect().bottom > document.querySelector('.shell').getBoundingClientRect().bottom + 1,
}));
if (adm.shellH < adm.vh) problems.push(`admin: shell ngắn hơn màn hình (${adm.shellH} < ${adm.vh})`);
if (adm.clipped) problems.push('admin: nội dung bị cắt khỏi shell');
await ctx.close();

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
