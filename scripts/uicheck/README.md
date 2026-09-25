# Browser checks

Playwright suites that assert on what the pages actually render, because the
failures they cover — a menu that cannot be closed, a composer pushed below the
fold, a price shown that differs from the price charged — all look like normal
code on the way in.

They run against a stub server, not a real backend: `serve.mjs` serves the
marketing site on 4600 and the application on 4601 with canned API answers, so
no database, payment gateway or model is involved.

```
npm install --no-save playwright
npx playwright install chromium        # skip if a Chromium is already present
node scripts/uicheck/serve.mjs &       # site 4600, app 4601
node scripts/uicheck/mob.mjs           # hamburger drawer on a phone
node scripts/uicheck/moball.mjs        # every page at 320px and 390px
node scripts/uicheck/chatlayout.mjs    # chat page at three widths, with and without the trial banner
node scripts/uicheck/cyc.mjs           # monthly / yearly prices in all three places
node scripts/uicheck/inbox.mjs         # contact inbox, including that hostile input renders as text
node scripts/uicheck/apiui.mjs         # API key tab, plan pricing, and the developer documentation
```

Each prints `vấn đề: không có` when it is clean, or a list naming the element
and the measurement that failed. `serve.mjs` reads the real `public/` and
`site/` folders, so the suites test the files as they will ship.

`serve.mjs` looks for the pages one directory up from itself by default; point
`APP_DIR` and `SITE_DIR` elsewhere if you move it.
