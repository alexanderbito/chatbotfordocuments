import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/**
 * Builds the PDF invoice a customer downloads from the billing page.
 *
 * Uses pdf-lib, which is already a dependency for splitting scanned PDFs, so
 * this adds no new rendering engine. The one addition is fontkit, needed to
 * embed a real font file: pdf-lib's built-in fonts are WinAnsi-only and throw
 * on any character outside it, which would make an invoice impossible to issue
 * to a customer whose registered name carries Vietnamese, Polish or Cyrillic
 * letters. Liberation Sans covers Latin, Latin Extended, Greek and Cyrillic.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

/** Who is issuing the invoice. */
export const SELLER = {
  name: 'BotClarify Co. Ltd',
  address: ['18 Marina Gardens Dr', 'Singapore 018953'],
  email: 'info@botclarify.com',
  site: 'botclarify.com',
};

const A4 = { w: 595.28, h: 841.89 };
const M = 52;                      // page margin
const INK = rgb(0.08, 0.09, 0.12);
const BODY = rgb(0.29, 0.32, 0.38);
const FAINT = rgb(0.48, 0.51, 0.57);
const RULE = rgb(0.89, 0.90, 0.92);
const BRAND = rgb(1, 0.388, 0.125);      // #ff6320, sampled from the logo
const PANEL = rgb(0.973, 0.976, 0.984);

// Read once per process rather than per download: an invoice is small but the
// font files are not, and Render's smallest instance has little memory to spare.
let cache = null;
function assets() {
  if (!cache) {
    cache = {
      regular: fs.readFileSync(path.join(ASSETS, 'fonts', 'LiberationSans-Regular.ttf')),
      bold: fs.readFileSync(path.join(ASSETS, 'fonts', 'LiberationSans-Bold.ttf')),
      logo: fs.readFileSync(path.join(ASSETS, 'brand', 'botclarify-logo.png')),
    };
  }
  return cache;
}

/**
 * Money and dates are formatted by hand rather than through toLocaleString.
 * An invoice is a financial record, and Intl output depends on which ICU data
 * the Node build happens to ship — a server without full ICU silently falls
 * back to a different format, so the same invoice would not look the same
 * everywhere. These two functions always produce the same thing.
 */
function money(amount, currency) {
  const n = Number(amount || 0);
  const neg = n < 0;
  const [whole, cents] = Math.abs(n).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${cents}`;
  const out = currency === 'USD' ? `$${body}` : `${body} ${currency || ''}`.trim();
  return neg ? `-${out}` : out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function day(d) {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return `${String(t.getUTCDate()).padStart(2, '0')} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/**
 * Wraps text to a pixel width. Long unbroken strings — a URL, or a company name
 * pasted without spaces — are split mid-word rather than allowed to run off the
 * edge of the page.
 */
function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) { out.push(line); line = ''; }
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) { out.push(chunk); chunk = ''; }
        chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Replaces characters the embedded font has no glyph for. Without this a
 * customer whose name is in Chinese, Thai or Arabic could not be invoiced at
 * all, because embedding would throw. Losing the accents on a name is bad;
 * being unable to issue the invoice is worse.
 */
function encodable(font, text) {
  const s = String(text ?? '');
  let out = '';
  for (const ch of s) {
    try { font.widthOfTextAtSize(ch, 10); out += ch; }
    catch { out += '?'; }
  }
  return out;
}

/**
 * @param {object} data
 * @param {object} data.payment  the payments row, already confirmed paid
 * @param {object} data.organization  the organizations row it belongs to
 * @param {object} [data.plan]   the plans row the payment was for
 * @returns {Promise<Uint8Array>}
 */
export async function buildInvoicePdf({ payment, organization, plan }) {
  const { regular, bold, logo } = assets();

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fRegular = await pdf.embedFont(regular, { subset: true });
  const fBold = await pdf.embedFont(bold, { subset: true });
  const img = await pdf.embedPng(logo);

  const page = pdf.addPage([A4.w, A4.h]);
  const right = A4.w - M;
  const clean = (t) => encodable(fRegular, t);

  pdf.setTitle(`Invoice ${payment.invoice_number} — ${SELLER.name}`);
  pdf.setAuthor(SELLER.name);
  pdf.setSubject(`Invoice for ${organization.name}`);
  pdf.setProducer('BotClarify');
  pdf.setCreator('BotClarify');

  const text = (s, x, y, { size = 10, font = fRegular, color = BODY, align = 'left' } = {}) => {
    const str = clean(s);
    const w = font.widthOfTextAtSize(str, size);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(str, { x: px, y, size, font, color });
    return w;
  };

  // ---------- Header: logo left, invoice identity right ----------
  const logoH = 56;
  const logoW = (img.width / img.height) * logoH;
  page.drawImage(img, { x: M, y: A4.h - M - logoH, width: logoW, height: logoH });

  let y = A4.h - M - 6;
  text('INVOICE', right, y - 8, { size: 22, font: fBold, color: INK, align: 'right' });
  y -= 30;
  text('Invoice number', right, y, { size: 9, color: FAINT, align: 'right' });
  y -= 13;
  text(payment.invoice_number || '—', right, y, { size: 11, font: fBold, color: INK, align: 'right' });
  y -= 19;
  text('Date of issue', right, y, { size: 9, color: FAINT, align: 'right' });
  y -= 13;
  text(day(payment.paid_at || payment.created_at), right, y, { size: 11, font: fBold, color: INK, align: 'right' });

  // ---------- Seller / customer ----------
  y = A4.h - M - logoH - 34;
  const colW = (right - M - 28) / 2;
  const rightColX = M + colW + 28;
  const topOfBlocks = y;

  text('FROM', M, y, { size: 8.5, font: fBold, color: BRAND });
  let ly = y - 16;
  text(SELLER.name, M, ly, { size: 11.5, font: fBold, color: INK });
  ly -= 15;
  for (const line of SELLER.address) { text(line, M, ly, { size: 10 }); ly -= 13; }
  text(SELLER.email, M, ly, { size: 10 }); ly -= 13;
  text(SELLER.site, M, ly, { size: 10, color: FAINT });

  let ry = topOfBlocks;
  text('BILL TO', rightColX, ry, { size: 8.5, font: fBold, color: BRAND });
  ry -= 16;
  const billName = organization.billing_name || organization.name || '—';
  for (const line of wrap(clean(billName), fBold, 11.5, colW)) {
    text(line, rightColX, ry, { size: 11.5, font: fBold, color: INK });
    ry -= 15;
  }
  if (organization.billing_address) {
    for (const line of wrap(clean(organization.billing_address), fRegular, 10, colW)) {
      text(line, rightColX, ry, { size: 10 }); ry -= 13;
    }
  }
  if (organization.contact_email) { text(organization.contact_email, rightColX, ry, { size: 10 }); ry -= 13; }
  if (organization.tax_code) { text(`Tax ID: ${organization.tax_code}`, rightColX, ry, { size: 10, color: FAINT }); ry -= 13; }

  // ---------- Line items ----------
  y = Math.min(ly, ry) - 34;
  const amountX = right;
  const qtyX = right - 118;
  const periodX = M + 232;

  page.drawRectangle({ x: M, y: y - 8, width: right - M, height: 26, color: PANEL });
  const headY = y + 2;
  text('DESCRIPTION', M + 12, headY, { size: 8.5, font: fBold, color: FAINT });
  text('PERIOD', periodX, headY, { size: 8.5, font: fBold, color: FAINT });
  text('QTY', qtyX, headY, { size: 8.5, font: fBold, color: FAINT });
  text('AMOUNT', amountX - 12, headY, { size: 8.5, font: fBold, color: FAINT, align: 'right' });

  y -= 30;
  const planName = plan?.name || 'Subscription';
  text(`${planName} plan`, M + 12, y, { size: 11, font: fBold, color: INK });
  const period = payment.period_start && payment.period_end
    ? `${day(payment.period_start)} - ${day(payment.period_end)}`
    : 'One month';
  text(period, periodX, y, { size: 10 });
  text('1', qtyX, y, { size: 10 });
  text(money(payment.amount, payment.currency), amountX - 12, y, { size: 11, font: fBold, color: INK, align: 'right' });

  if (plan?.description) {
    y -= 14;
    for (const line of wrap(clean(plan.description), fRegular, 9.5, 200)) {
      text(line, M + 12, y, { size: 9.5, color: FAINT }); y -= 12;
    }
  }

  y -= 16;
  page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 1, color: RULE });

  // ---------- Total ----------
  y -= 24;
  text('Subtotal', amountX - 118, y, { size: 10 });
  text(money(payment.amount, payment.currency), amountX, y, { size: 10, color: INK, align: 'right' });

  y -= 14;
  page.drawLine({ start: { x: amountX - 200, y }, end: { x: right, y }, thickness: 1, color: RULE });
  y -= 24;
  text('Total paid', amountX - 200, y, { size: 13, font: fBold, color: INK });
  text(money(payment.amount, payment.currency), amountX, y, { size: 16, font: fBold, color: INK, align: 'right' });

  // ---------- Paid stamp ----------
  y -= 34;
  const badge = `PAID on ${day(payment.paid_at)}`;
  const badgeW = fBold.widthOfTextAtSize(badge, 10) + 26;
  page.drawRectangle({
    x: right - badgeW, y: y - 7, width: badgeW, height: 26,
    color: rgb(0.902, 0.965, 0.933), borderColor: rgb(0.753, 0.906, 0.831), borderWidth: 1,
  });
  text(badge, right - 13, y, { size: 10, font: fBold, color: rgb(0.024, 0.478, 0.306), align: 'right' });

  // ---------- Payment details ----------
  y -= 52;
  text('PAYMENT DETAILS', M, y, { size: 8.5, font: fBold, color: BRAND });
  y -= 17;
  const methodLabel = { paypal: 'PayPal / card', manual: 'Recorded manually', bank_transfer: 'Bank transfer', card: 'Card' };
  const rows = [
    ['Method', methodLabel[payment.method || payment.provider] || payment.method || payment.provider || '—'],
    ['Reference', payment.provider_ref || payment.reference || String(payment.order_code || '—')],
    ['Currency', payment.currency || 'USD'],
  ];
  for (const [label, value] of rows) {
    text(label, M, y, { size: 9.5, color: FAINT });
    text(String(value), M + 92, y, { size: 9.5, color: BODY });
    y -= 15;
  }

  // ---------- Notes ----------
  y -= 18;
  page.drawRectangle({ x: M, y: y - 44, width: right - M, height: 62, color: PANEL });
  text('NOTES', M + 14, y, { size: 8.5, font: fBold, color: BRAND });
  y -= 16;
  text('Thank you for your business. No tax has been charged on this invoice.', M + 14, y, { size: 9.5 });
  y -= 14;
  text(`Questions about this invoice? Write to ${SELLER.email} quoting the invoice number above.`, M + 14, y, { size: 9.5, color: FAINT });

  // ---------- Footer ----------
  const footY = M + 26;
  page.drawLine({ start: { x: M, y: footY + 26 }, end: { x: right, y: footY + 26 }, thickness: 1, color: RULE });
  text(
    `${SELLER.name} · ${SELLER.address.join(', ')} · ${SELLER.email}`,
    A4.w / 2, footY + 10, { size: 8.5, color: FAINT, align: 'center' }
  );
  text(
    'This invoice was generated electronically and is valid without a signature.',
    A4.w / 2, footY - 2, { size: 8.5, color: FAINT, align: 'center' }
  );

  return pdf.save();
}

/** A filename a person can find again in their downloads folder. */
export function invoiceFilename(payment) {
  const safe = String(payment.invoice_number || payment.order_code || payment.id).replace(/[^A-Za-z0-9._-]/g, '-');
  return `BotClarify-invoice-${safe}.pdf`;
}
