import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

for (const [name, url] of [['m-admin','/admin.html#overview'], ['m-chat','/chat.html'], ['m-sysadmin','/sysadmin.html']]) {
  const pg = await ctx.newPage();
  pg.on('pageerror', e => problems.push(`${name}: JS ${e.message}`));
  await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
  await pg.goto('http://localhost:4601'+url, { waitUntil: 'networkidle' });
  // The stub answers some endpoints with the wrong shape, which raises an error
  // toast over the topbar. Wait it out so the screenshots show the real thing.
  await pg.waitForTimeout(4200);

  const closed = await pg.evaluate(() => {
    const sb = document.getElementById('appSidebar'), tb = document.querySelector('.topbar');
    const tg = document.querySelector('.nav-toggle');
    return {
      toggleVisible: !!tg && tg.getBoundingClientRect().width > 0,
      toggleFirst: tb?.firstElementChild === tg,
      drawerOffscreen: sb.getBoundingClientRect().right <= 0,
      expanded: tg?.getAttribute('aria-expanded'),
      scrimClickable: getComputedStyle(document.querySelector('.nav-scrim')).pointerEvents,
      // Nothing of the navigation may eat vertical space before the content.
      contentTop: Math.round(document.querySelector('.topbar').getBoundingClientRect().top),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  if (!closed.toggleVisible) problems.push(`${name}: không thấy nút hamburger`);
  if (!closed.toggleFirst) problems.push(`${name}: hamburger không nằm đầu topbar`);
  if (!closed.drawerOffscreen) problems.push(`${name}: ngăn kéo không ẩn khi đóng`);
  if (closed.expanded !== 'false') problems.push(`${name}: aria-expanded ban đầu = ${closed.expanded}`);
  if (closed.scrimClickable !== 'none') problems.push(`${name}: lớp phủ chặn bấm khi đóng`);
  if (closed.contentTop !== 0) problems.push(`${name}: còn thứ gì đó phía trên topbar (${closed.contentTop}px)`);
  if (closed.overflowX) problems.push(`${name}: tràn ngang`);
  await pg.screenshot({ path: `./${name}.png` });

  // The hamburger and the heading must share the first row: the heading has
  // flex-basis 0 so it wraps its own text rather than pushing itself onto a
  // line of its own and leaving the button alone above it.
  const row1 = await pg.evaluate(() => {
    const tg = document.querySelector('.nav-toggle').getBoundingClientRect();
    const ti = document.querySelector('.topbar .title').getBoundingClientRect();
    const h1 = document.querySelector('.topbar .title h1');
    // Anything else sharing the heading's row is what squeezes it.
    const intruders = [...document.querySelectorAll('.topbar > .btn, .topbar > .badge')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.top < ti.bottom - 2 && ti.top < r.bottom - 2; })
      .map((el) => el.textContent.trim().slice(0, 20));
    return {
      sameRow: tg.top < ti.bottom && ti.top < tg.bottom,
      intruders,
      // A heading wrapped onto three or more lines on a phone means it is being
      // rendered in a column too narrow to be a heading.
      h1Lines: Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight)),
      titleWidth: Math.round(ti.width),
    };
  });
  if (!row1.sameRow) problems.push(`${name}: tiêu đề không cùng hàng với nút hamburger`);
  if (row1.intruders.length) problems.push(`${name}: nút chen vào hàng tiêu đề — ${row1.intruders.join(', ')}`);
  if (row1.h1Lines > 2) problems.push(`${name}: tiêu đề bị ép xuống ${row1.h1Lines} dòng (rộng ${row1.titleWidth}px)`);

  // On the chat page the composer must be reachable without scrolling the page.
  if (await pg.locator('.composer').count()) {
    const c = await pg.evaluate(() => {
      const box = document.querySelector('.composer').getBoundingClientRect();
      return { bottom: Math.round(box.bottom), vh: window.innerHeight,
               pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1 };
    });
    if (c.bottom > c.vh + 1) problems.push(`${name}: ô nhập câu hỏi tràn xuống dưới màn hình (${c.bottom} > ${c.vh})`);
    if (c.pageScrolls) problems.push('m-chat: cả trang cuộn được, lẽ ra chỉ danh sách tin nhắn mới cuộn');
  }

  await pg.click('.nav-toggle');
  await pg.waitForTimeout(400);
  const open = await pg.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    return {
      onScreen: sb.getBoundingClientRect().left === 0,
      expanded: document.querySelector('.nav-toggle').getAttribute('aria-expanded'),
      bodyLocked: document.body.classList.contains('nav-open'),
      pageInert: !!document.querySelector('.page, .page-section')?.closest('[inert]'),
      focusInDrawer: sb.contains(document.activeElement),
      scrimOn: getComputedStyle(document.querySelector('.nav-scrim')).pointerEvents === 'auto',
      closeBtnVisible: sb.querySelector('.drawer-close')?.getBoundingClientRect().width > 0,
    };
  });
  if (!open.onScreen) problems.push(`${name}: ngăn kéo không mở ra`);
  if (open.expanded !== 'true') problems.push(`${name}: aria-expanded khi mở = ${open.expanded}`);
  if (!open.bodyLocked) problems.push(`${name}: trang nền vẫn cuộn được khi ngăn kéo mở`);
  if (!open.pageInert) problems.push(`${name}: nội dung trang sau ngăn kéo không bị inert`);
  if (!open.focusInDrawer) problems.push(`${name}: mở ngăn kéo mà tiêu điểm không vào trong`);
  if (!open.scrimOn) problems.push(`${name}: lớp phủ không nhận bấm khi mở`);
  if (!open.closeBtnVisible) problems.push(`${name}: không có nút đóng trong ngăn kéo`);
  await pg.screenshot({ path: `./${name}-open.png` });

  // The hamburger must still WORK while the drawer is open. A finger cannot
  // reach it — the drawer is drawn over that corner, which is why the X and the
  // scrim exist — but a keyboard can, and aria-expanded promises it toggles.
  // Marking .main inert broke exactly this: the button sits inside .main's
  // topbar, inert disables a whole subtree, so the control that claimed to be
  // expanded could no longer collapse anything.
  const kb = await pg.evaluate(() => {
    const tg = document.querySelector('.nav-toggle');
    if (tg.closest('[inert]')) return 'nút hamburger bị inert khi ngăn kéo mở';
    tg.click();
    return null;
  });
  if (kb) problems.push(`${name}: ${kb}`);
  await pg.waitForTimeout(400);
  if (!(await pg.evaluate(() => document.getElementById('appSidebar').getBoundingClientRect().right <= 0)))
    problems.push(`${name}: kích hoạt lại hamburger không đóng được ngăn kéo`);
  await pg.click('.nav-toggle');
  await pg.waitForTimeout(400);

  // Escape must close it, and focus must come back to the hamburger.
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(350);
  const afterEsc = await pg.evaluate(() => ({
    off: document.getElementById('appSidebar').getBoundingClientRect().right <= 0,
    focusBack: document.activeElement === document.querySelector('.nav-toggle'),
    unlocked: !document.body.classList.contains('nav-open'),
    notInert: !document.querySelector('.page, .page-section')?.closest('[inert]'),
  }));
  if (!afterEsc.off) problems.push(`${name}: Esc không đóng ngăn kéo`);
  if (!afterEsc.focusBack) problems.push(`${name}: đóng xong tiêu điểm không quay lại nút hamburger`);
  if (!afterEsc.unlocked) problems.push(`${name}: đóng rồi trang vẫn khoá cuộn`);
  if (!afterEsc.notInert) problems.push(`${name}: đóng rồi nội dung vẫn inert`);

  // Nothing behind the scrim may be reachable by Tab — including the trial
  // banner, which lives outside .shell and so escapes any .main-based guard.
  await pg.click('.nav-toggle'); await pg.waitForTimeout(350);
  const reachable = await pg.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    const inInert = (el) => el.closest('[inert]') !== null;
    return [...document.querySelectorAll('a[href], button, select, textarea, input, [tabindex]')]
      .filter((el) => el.getBoundingClientRect().width > 0
                   && !sb.contains(el)
                   && el !== document.querySelector('.nav-toggle')
                   && !inInert(el))
      .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 22));
  });
  if (reachable.length) problems.push(`${name}: sau lớp phủ vẫn Tab tới được — ${[...new Set(reachable)].slice(0,3).join(', ')}`);
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(350);

  // A closed drawer is off-canvas, not hidden: its controls must leave the tab
  // order too, or Tab wanders through an invisible menu.
  const ghost = await pg.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    return sb.hasAttribute('inert') ? [] :
      [...sb.querySelectorAll('a[href], button, select')].map((el) => el.tagName.toLowerCase());
  });
  if (ghost.length) problems.push(`${name}: ngăn kéo đóng nhưng ${ghost.length} nút bên trong vẫn Tab tới được`);

  // Tapping the scrim closes it too.
  await pg.click('.nav-toggle'); await pg.waitForTimeout(350);
  await pg.mouse.click(370, 500); await pg.waitForTimeout(350);
  if (!(await pg.evaluate(() => document.getElementById('appSidebar').getBoundingClientRect().right <= 0)))
    problems.push(`${name}: bấm ra ngoài không đóng ngăn kéo`);

  // Choosing a menu item closes it rather than leaving it over the new page.
  if (await pg.locator('#appSidebar .nav-item[data-view]').count()) {
    await pg.click('.nav-toggle'); await pg.waitForTimeout(350);
    await pg.locator('#appSidebar .nav-item[data-view]').nth(1).click();
    await pg.waitForTimeout(400);
    if (!(await pg.evaluate(() => document.getElementById('appSidebar').getBoundingClientRect().right <= 0)))
      problems.push(`${name}: chọn mục menu xong ngăn kéo vẫn che trang`);
  }
  // On the chat page, switching to the history view must actually hide the chat
  // view. A :has() rule outranking ".page-section { display: none }" left both
  // stacked on top of each other, at every width.
  if (name === 'm-chat') {
    await pg.evaluate(() => { location.hash = 'history'; });
    await pg.waitForTimeout(500);
    const both = await pg.evaluate(() => {
      const chat = document.querySelector('.page-section[data-view="chat"]');
      return { chatShown: getComputedStyle(chat).display !== 'none',
               chatH: Math.round(chat.getBoundingClientRect().height) };
    });
    if (both.chatShown) problems.push(`m-chat: đổi sang History mà khung chat vẫn hiện (cao ${both.chatH}px)`);
    await pg.evaluate(() => { location.hash = 'chat'; });
    await pg.waitForTimeout(400);
  }

  await pg.close();
}

// Above the breakpoint nothing may change: no hamburger, sidebar back in the flow.
const wide = await b.newPage({ viewport: { width: 1400, height: 900 } });
await wide.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
await wide.goto('http://localhost:4601/admin.html#overview', { waitUntil: 'networkidle' });
await wide.waitForTimeout(700);
const d = await wide.evaluate(() => ({
  toggleHidden: getComputedStyle(document.querySelector('.nav-toggle')).display === 'none',
  closeHidden: getComputedStyle(document.querySelector('.drawer-close')).display === 'none',
  sidebarInFlow: getComputedStyle(document.getElementById('appSidebar')).position === 'sticky',
  sidebarLeft: document.getElementById('appSidebar').getBoundingClientRect().left,
}));
if (!d.toggleHidden) problems.push('desktop: hamburger vẫn hiện');
if (!d.closeHidden) problems.push('desktop: nút đóng ngăn kéo vẫn hiện');
if (!d.sidebarInFlow) problems.push('desktop: sidebar không còn sticky');
if (d.sidebarLeft !== 0) problems.push('desktop: sidebar lệch khỏi mép trái');
await wide.close();

console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
