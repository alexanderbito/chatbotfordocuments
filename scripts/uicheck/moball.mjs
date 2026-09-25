import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];

// Two phone widths: the narrowest in common use, and a typical modern one.
for (const w of [320, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pages = [
    ['site', 4600, '/'], ['site', 4600, '/security.html'], ['site', 4600, '/contact.html'],
    ['site', 4600, '/terms.html'], ['site', 4600, '/privacy.html'],
    ['app', 4601, '/login.html'], ['app', 4601, '/register.html'], ['app', 4601, '/pricing.html'],
    ['app', 4601, '/admin.html#billing'], ['app', 4601, '/chat.html'], ['app', 4601, '/sysadmin.html'],
  ];
  for (const [side, port, url] of pages) {
    const pg = await ctx.newPage();
    await pg.addInitScript(() => { try { localStorage.setItem('botclarify_token','t'); localStorage.setItem('botclarify_org','o1'); } catch {} });
    await pg.goto(`http://localhost:${port}${url}`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(600);
    const r = await pg.evaluate(() => {
      const docW = document.documentElement.scrollWidth, winW = window.innerWidth;
      // Which element is actually sticking out? Naming it is the difference
      // between "something overflows" and a fix.
      const wide = [];
      if (docW > winW + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > winW + 1 && getComputedStyle(el).position !== 'fixed') {
            wide.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 26) + ' right=' + Math.round(b.right));
            if (wide.length > 2) break;
          }
        }
      }
      // Anything a finger has to hit should be at least 32px tall.
      const small = [...document.querySelectorAll('button, a.btn, .nav-item, input[type=checkbox], input[type=radio]')]
        .filter((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.height < 32; })
        .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 20) + ' h=' + Math.round(el.getBoundingClientRect().height));
      return { over: docW > winW + 1, wide, small: [...new Set(small)].slice(0, 3) };
    });
    const label = `${url}@${w}`;
    if (r.over) problems.push(`${label}: tràn ngang — ${r.wide.join(' | ') || '(không xác định)'}`);
    if (r.small.length) problems.push(`${label}: vùng bấm quá nhỏ — ${r.small.join(' | ')}`);
    await pg.close();
  }
  await ctx.close();
}
console.log('vấn đề:', problems.length ? problems : 'không có');
await b.close();
