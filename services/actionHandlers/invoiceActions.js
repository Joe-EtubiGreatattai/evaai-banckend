// services/actionHandlers/invoiceActions.js
const mongoose = require('mongoose');
const { addDays } = require('date-fns');
const puppeteer = require('puppeteer');
const path = require('path');

const Invoice = require('../../models/Invoice');
const User = require('../../models/User');
const sendEmail = require('./../emailService');
const XeroService = require('./xeroService');

/* ----------------------------- Logo utilities ----------------------------- */

const DEFAULT_LOGO_URL = 'https://res.cloudinary.com/doefjylyu/image/upload/v1758241696/Screenshot_2025-09-19_at_1.26.46_am_ihuhta.png';

const fetchShim = global.fetch
  ? global.fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

async function loadLogoAsDataUrl(url) {
  try {
    const res = await fetchShim(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    let ext = '';
    try { ext = (path.extname(new URL(url).pathname) || '').slice(1).toLowerCase(); } catch {}

    const mime =
      ext === 'png' ? 'image/png' :
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'svg' ? 'image/svg+xml' :
      'image/png';

    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function resolveLogoDataUrl(opts = {}) {
  const { logoDataUrl, logoUrl } = opts || {};
  if (logoDataUrl && /^data:image\//.test(String(logoDataUrl))) return logoDataUrl;

  if (logoUrl) {
    const d = await loadLogoAsDataUrl(logoUrl);
    if (d) return d;
  }

  if (process.env.COMPANY_LOGO) {
    const d = await loadLogoAsDataUrl(process.env.COMPANY_LOGO);
    if (d) return d;
  }

  if (DEFAULT_LOGO_URL) {
    const d = await loadLogoAsDataUrl(DEFAULT_LOGO_URL);
    if (d) return d;
  }

  const FallbackSVG = Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='80' viewBox='0 0 240 80'>
      <rect width='100%' height='100%' rx='10' fill='#ffffff' stroke='#e5e7eb'/>
      <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='22' font-family='Inter, Arial, sans-serif' fill='#111827'>LOGO</text>
     </svg>`
  ).toString('base64');
  return `data:image/svg+xml;base64,${FallbackSVG}`;
}

/* ------------------------------- User lookup ------------------------------ */

function normalizePhoneDigits(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function getIssuerByPhoneOrUserId(userId, phoneNumber) {
  const normalized = normalizePhoneDigits(phoneNumber);
  if (normalized) {
    const byPhone = await User.findOne({ phoneNumber: normalized }).lean();
    if (byPhone) return byPhone;
  }
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    const byId = await User.findById(userId).lean();
    if (byId) return byId;
  }
  return null;
}

/* ------------------------- Reference generation utils ------------------------- */

const last6 = (id) => {
  try { return String(id || '').slice(-6).toUpperCase(); } catch { return 'XXXXXX'; }
};
const yyyymmdd = (d) => {
  const dt = d ? new Date(d) : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};
const initials = (s) => {
  if (!s) return 'CUST';
  const parts = String(s).trim().split(/\s+/).slice(0, 3);
  const ini = parts.map(p => p[0]).join('');
  return (ini || 'CUST').toUpperCase();
};

/**
 * Build a stable human reference.
 * Format: REF-{CLIENTINITIALS}-{YYYYMMDD}-{LAST6}
 */
function buildReference({ invoice, fallbackClientName }) {
  const refClient = invoice?.accountName || invoice?.clientName || fallbackClientName || 'CUST';
  const refDate = invoice?.date || new Date();
  const refIdLast6 = last6(invoice?._id || invoice?.invoiceNumber);
  return `REF-${initials(refClient)}-${yyyymmdd(refDate)}-${refIdLast6}`;
}

/* --------------------------------- Search -------------------------------- */

const findInvoice = async (userId, identifier) => {
  if (!identifier) return null;

  if (mongoose.Types.ObjectId.isValid(identifier)) {
    return await Invoice.findOne({ _id: identifier, user: userId });
  }

  const amountMatch = String(identifier).match(/(\$?\d+(\.\d{1,2})?)/);
  if (amountMatch) {
    const amount = parseFloat(amountMatch[1].replace('$', ''));
    const amountInvoices = await Invoice.find({ amount, user: userId }).sort({ createdAt: -1 }).limit(5);
    if (amountInvoices.length > 0) return amountInvoices[0];
  }

  const dateParsed = new Date(identifier);
  if (!isNaN(dateParsed.getTime())) {
    const dateInvoices = await Invoice.find({
      $or: [{ date: dateParsed }, { dueDate: dateParsed }],
      user: userId
    }).sort({ createdAt: -1 }).limit(5);
    if (dateInvoices.length > 0) return dateInvoices[0];
  }

  const nameInvoices = await Invoice.find({
    clientName: { $regex: new RegExp(identifier, 'i') },
    user: userId
  }).sort({ createdAt: -1 }).limit(5);

  return nameInvoices[0];
};

/* ------------------------------ Email content ----------------------------- */

const generateInvoiceEmail = (invoice, emailAddress) => {
  const formattedDate = invoice.date ? new Date(invoice.date).toLocaleDateString() : 'N/A';
  const formattedDueDate = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A';

  const currency = invoice.currency || 'GBP';
  const nf = new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 2 });
  const formattedAmount = nf.format(Number(invoice.amount || 0));

  const statusColor =
    invoice.status === 'Paid' ? '#2ecc71' :
    invoice.status === 'Overdue' ? '#e74c3c' :
    '#f39c12';

  const invoiceIdentifier = invoice.invoiceNumber
    ? `#${invoice.invoiceNumber}`
    : invoice._id
      ? `(ID: ${invoice._id.toString()})`
      : '';

  const text = `
Invoice Details
---------------
Client: ${invoice.clientName}
Invoice: ${invoiceIdentifier}
Invoice Date: ${formattedDate}
Due Date: ${formattedDueDate}
Amount: ${formattedAmount}
Status: ${invoice.status}
Description: ${invoice.description || 'N/A'}
Reference: ${invoice.paymentReference || invoice.reference || 'N/A'}
${invoice.xeroInvoiceId ? `Xero Invoice ID: ${invoice.xeroInvoiceId}` : ''}

Thank you for your business!
  `;

  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 5px;">
  <h2 style="color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px;">Invoice Details</h2>
  <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;width:30%;">Client:</td><td style="padding:10px;border-bottom:1px solid #eee;">${invoice.clientName}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Invoice:</td><td style="padding:10px;border-bottom:1px solid #eee;">${invoiceIdentifier}</td></tr>
    ${invoice.xeroInvoiceId ? `<tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:700;">Xero ID:</td><td style="padding:10px;border-bottom:1px solid #eee;">${invoice.xeroInvoiceId}</td></tr>` : ''}
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Invoice Date:</td><td style="padding:10px;border-bottom:1px solid #eee;">${formattedDate}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Due Date:</td><td style="padding:10px;border-bottom:1px solid #eee;">${formattedDueDate}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Amount:</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:700;">${formattedAmount}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Status:</td><td style="padding:10px;border-bottom:1px solid #eee;color:${statusColor};">${invoice.status}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Reference:</td><td style="padding:10px;border-bottom:1px solid #eee;">${invoice.paymentReference || invoice.reference || ''}</td></tr>
    <tr><td style="padding: 10px;border-bottom:1px solid #eee;font-weight:700;">Description:</td><td style="padding:10px;border-bottom:1px solid #eee;">${invoice.description || 'N/A'}</td></tr>
  </table>
  <p style="margin-top: 30px; font-style: italic; text-align: center; color: #7f8c8d;">Thank you for your business.</p>
</div>`;

  return {
    to: emailAddress,
    subject: `Invoice ${invoiceIdentifier} from ${invoice.clientName} - ${formattedAmount}`,
    text,
    html
  };
};

/* ------------------------------ PDF generation ---------------------------- */

const generateInvoicePDF = async (invoice, options = {}) => {
  if (!invoice) throw new Error('Invoice data is required');

  const cfg = {
    pageSize: 'A4',
    marginMM: 12,
    currency: invoice.currency || options.currency || 'GBP',
    logoDataUrl: options.logoDataUrl || invoice.logoDataUrl || null,
    logoUrl: options.logoUrl || invoice.logoUrl || null,
  };

  const nf = new Intl.NumberFormat('en-GB', { style: 'currency', currency: cfg.currency, maximumFractionDigits: 2 });
  const money = (n) => nf.format(Number(n || 0));

  const esc = (s = '') => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const dt = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-GB'); } catch { return ''; }
  };

  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const lineSubtotal = items.length
    ? items.reduce((sum, it) => {
        const qty = Number(it.quantity ?? 1) || 1;
        const unit = Number(it.unitPrice ?? it.unit_price ?? it.unitAmount ?? it.amount ?? 0) || 0;
        return sum + qty * unit;
      }, 0)
    : Number(invoice.subtotal ?? invoice.amount ?? 0) || 0;

  const reverseCharge = !!invoice.reverseCharge;
  const vatPercent = reverseCharge ? 20 : (Number(invoice.vatPercent ?? (invoice.taxRate * 100)) || 0);
  const vatRate = reverseCharge ? 0 : (vatPercent / 100);
  const taxAmount = reverseCharge ? 0 : Number(invoice.taxAmount ?? lineSubtotal * vatRate) || 0;

  const subtotal = lineSubtotal;
  const totalBeforeDiscount = subtotal + taxAmount;
  const discountAmount = Math.max(0, Number(invoice.discountAmount || 0));
  const total = Math.max(0, totalBeforeDiscount - discountAmount);

  const invoiceNumber = invoice.invoiceNumber || (invoice._id ? String(invoice._id).slice(-6) : 'INV');

  const brand = {
    name: (invoice.brand && invoice.brand.name) || invoice.businessName || process.env.COMPANY_NAME || 'Your Company',
    tradingName: (invoice.brand && invoice.brand.tradingName) || invoice.tradingName || null,
    address: (invoice.brand && invoice.brand.address) || invoice.businessAddress || process.env.COMPANY_ADDRESS || '',
    email: (invoice.brand && invoice.brand.email) || invoice.businessEmail || process.env.COMPANY_EMAIL || '',
    phone: (invoice.brand && invoice.brand.phone) || invoice.businessPhone || process.env.COMPANY_PHONE || '',
    number: (invoice.brand && invoice.brand.number) || invoice.companyNumber || process.env.COMPANY_NUMBER || '',
    vatNumber: invoice.vatNumber || (invoice.brand && invoice.brand.vatNumber) || process.env.COMPANY_VAT || ''
  };

  const pay = {
    method: invoice.paymentMethod || (invoice.pay && invoice.pay.method) || 'BACs',
    bankName: invoice.bankName || (invoice.pay && invoice.pay.bankName) || 'Natwest',
    bankAddress: invoice.bankAddress || (invoice.pay && invoice.pay.bankAddress) || '',
    accountName: invoice.accountName || (invoice.pay && invoice.pay.accountName) || brand.tradingName || brand.name,
    accountNumber: invoice.accountNumber || (invoice.pay && invoice.pay.accountNumber) || '',
    sortCode: invoice.sortCode || (invoice.pay && invoice.pay.sortCode) || '',
    iban: invoice.iban || (invoice.pay && invoice.pay.iban),
    bic: invoice.swiftBIC || invoice.swift || (invoice.pay && (invoice.pay.bic || invoice.pay.swiftBIC)),
    paymentReference: invoice.paymentReference || invoice.reference || buildReference({ invoice }),
  };

  const recipientLines = [
    invoice.clientName || invoice.customerName,
    invoice.clientAddress || invoice.customerAddress,
    invoice.clientEmail || invoice.customerEmail
  ].filter(Boolean);

  const logoDataUrl = await resolveLogoDataUrl({ logoDataUrl: cfg.logoDataUrl, logoUrl: cfg.logoUrl });

  const rows = (items.length ? items : [{
    description: invoice.description || 'Services rendered',
    quantity: 1,
    unitPrice: subtotal,
    vatText: reverseCharge ? 'Domestic Reverse Charge @ 20% (VAT on Income)' : (vatPercent ? `${vatPercent}%` : '0%')
  }]).map(it => {
    const qty = Number(it.quantity ?? 1) || 1;
    const unit = Number(it.unitPrice ?? it.unit_price ?? it.unitAmount ?? it.amount ?? 0) || 0;
    const amount = qty * unit;
    const vatText = reverseCharge
      ? 'Domestic Reverse\nCharge @ 20% (VAT\non Income)'
      : (typeof it.vatPercent === 'number' ? `${it.vatPercent}%` : (vatPercent ? `${vatPercent}%` : '0%'));
    return `<tr>
      <td class="l desc">${esc(String(it.description || 'No description'))}</td>
      <td class="r">${qty.toFixed(2)}</td>
      <td class="r">${unit.toFixed(2)}</td>
      <td class="r vat">${esc(vatText)}</td>
      <td class="r">${amount.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const box = (label, value, strong=false) =>
    `<div class="box">
      <div class="lbl">${esc(label)}</div>
      <div class="${strong ? 'val strong' : 'val'}">${esc(value || '')}</div>
    </div>`;

  const paymentAdvice = `
  <div class="advice">
    <div class="advice-title">PAYMENT ADVICE</div>
    <div class="advice-grid">
      <div>
        <div class="advice-to">To: ${esc(brand.tradingName || brand.name)}</div>
        ${brand.address ? `<div class="advice-lines">${esc(brand.address).replace(/\n/g,'<br>')}</div>` : ''}
        ${brand.number ? `<div class="advice-reg">Company Registration No: ${esc(brand.number)}.</div>` : ''}
      </div>
      <div class="advice-right">
        ${box('Customer', invoice.customerName || invoice.clientName)}
        ${box('Invoice Number', invoiceNumber)}
        ${box('Amount Due', `${money(total)}`, true)}
        ${box('Due Date', dt(invoice.dueDate))}
        <div class="advice-enter">Amount Enclosed&nbsp;&nbsp;&nbsp;__________</div>
        <div class="advice-note">Enter the amount you are paying above</div>
      </div>
    </div>
  </div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(invoiceNumber)} - Tax Invoice</title>
<style>
  @page { size: ${esc(cfg.pageSize || 'A4')}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; color: #111; font-size: 11.5px; }
  .header { display: grid; grid-template-columns: 140px 1fr 220px; gap: 16px; align-items: center; margin-bottom: 8px; }
  .logo img { width: 120px; height: auto; object-fit: contain; }
  .issuer small { color: #555; display:block; }
  .issuer .name { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
  .docbadge { text-align: right; }
  .docbadge .title { font-size: 18px; font-weight: 800; letter-spacing: .4px; }
  .divider { border-top: 2px solid #ddd; margin: 6px 0 12px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 8px; }
  .panel { border: 1px solid #e5e7eb; padding: 10px; border-radius: 4px; }
  .panel .lbl { color:#666; font-size: 10.5px; }
  .panel .val { font-weight:600; }
  .meta { display:grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin: 10px 0 14px; }
  .box { border:1px solid #e5e7eb; border-radius:4px; padding:8px; }
  .box .lbl { color:#666; font-size:10.5px; margin-bottom:2px; }
  .box .val { font-weight:600; }
  .box .val.strong { font-weight:800; font-size: 13px; }
  table { width:100%; border-collapse: collapse; }
  th, td { padding: 8px 6px; border-bottom:1px solid #eee; }
  th { text-align:left; color:#333; font-weight:700; background:#fafafa; }
  td.r, th.r { text-align:right; white-space:nowrap; }
  td.l { text-align:left; }
  td.vat { white-space: pre-line; }
  .totals { width: 320px; margin-left:auto; margin-top: 10px; }
  .totals .row { display:grid; grid-template-columns: 1fr auto; gap: 8px; }
  .totals .row .lbl { text-align:right; color:#333; }
  .totals .row .val { text-align:right; font-weight:600; }
  .totals .grand .lbl { font-weight:800; }
  .totals .grand .val { font-weight:800; font-size: 13px; }
  .rc-note { margin-top: 8px; font-size: 10.5px; color:#333; }
  .rc-note .muted { color:#666; }
  .pay { margin-top: 16px; }
  .pay h4 { margin:0 0 6px; font-size: 12.5px; }
  .pay .grid { display:grid; grid-template-columns: repeat(4,1fr); gap: 8px 14px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace; }
  .advice { margin-top: 18px; border:1px solid #000; padding: 10px; }
  .advice-title { font-weight:800; font-size: 14px; border-bottom:1px solid #000; padding-bottom:6px; margin-bottom:8px; }
  .advice-grid { display:grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
  .advice-to { font-weight:700; margin-bottom:4px; }
  .advice-lines { white-space: pre-line; }
  .advice-reg { margin-top: 8px; font-size: 10.5px; }
  .advice-right .advice-enter { margin-top: 8px; }
  .advice-right .advice-note { font-size: 10.5px; color: #555; }
  .footline { margin-top: 16px; font-size: 10.5px; color:#555; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo"><img src="${logoDataUrl}" alt="Company logo" /></div>
    <div class="issuer">
      <div class="name">${esc(brand.tradingName || brand.name)}</div>
      ${brand.address ? `<small>${esc(brand.address).replace(/\n/g,'<br>')}</small>` : ''}
      ${brand.email ? `<small>${esc(brand.email)}</small>` : ''}
      ${brand.phone ? `<small>${esc(brand.phone)}</small>` : ''}
      ${brand.number ? `<small>Company Registration No: ${esc(brand.number)}</small>` : ''}
      ${brand.vatNumber ? `<small>VAT Number: ${esc(brand.vatNumber)}</small>` : ''}
    </div>
    <div class="docbadge"><div class="title">TAX INVOICE</div></div>
  </div>

  <div class="divider"></div>

  <div class="grid-2">
    <div class="panel">
      <div class="lbl">Bill To</div>
      <div class="val">${recipientLines.length ? recipientLines.map(esc).join('<br>') : esc(invoice.clientName || '')}</div>
    </div>
    <div class="meta">
      ${box('Invoice Date', dt(invoice.date || new Date()))}
      ${box('Invoice Number', invoiceNumber)}
      ${box('Reference', pay.paymentReference)}
      ${box('VAT Number', brand.vatNumber)}
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th>Description</th>
        <th class="r">Quantity</th>
        <th class="r">Unit Price</th>
        <th class="r">VAT</th>
        <th class="r">Amount GBP</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><div class="lbl">Subtotal</div><div class="val">${money(subtotal)}</div></div>
    <div class="row"><div class="lbl">TOTAL VAT</div><div class="val">${money(taxAmount)}</div></div>
    ${discountAmount > 0 ? `<div class="row"><div class="lbl">Discount</div><div class="val">- ${money(discountAmount)}</div></div>` : ''}
    <div class="row grand"><div class="lbl">TOTAL GBP</div><div class="val">${money(total)}</div></div>
    <div class="row"><div class="lbl">Due Date</div><div class="val">${dt(invoice.dueDate)}</div></div>
  </div>

  ${reverseCharge ? `
  <div class="rc-note">
    <strong>Reverse charge applies</strong> to items marked with '<span class="muted">Domestic reverse charge</span>'. Customers need to account for VAT on these items to HMRC, at the rate shown.
  </div>` : ''}

  <div class="pay">
    <h4>Payment Details (${esc(pay.method)})</h4>
    <div class="grid">
      <div><div class="lbl">Bank</div><div class="val">${esc(pay.bankName)}</div></div>
      ${pay.bankAddress ? `<div><div class="lbl">Bank Address</div><div class="val">${esc(pay.bankAddress)}</div></div>` : '<div></div>'}
      <div><div class="lbl">Account Name</div><div class="val">${esc(pay.accountName)}</div></div>
      <div><div class="lbl">Reference</div><div class="val mono">${esc(pay.paymentReference)}</div></div>
      <div><div class="lbl">Account Number</div><div class="val mono">${esc(pay.accountNumber)}</div></div>
      <div><div class="lbl">Sort code</div><div class="val mono">${esc(pay.sortCode)}</div></div>
      ${pay.iban ? `<div><div class="lbl">IBAN</div><div class="val mono">${esc(pay.iban)}</div></div>` : ''}
      ${pay.bic ? `<div><div class="lbl">BIC/SWIFT</div><div class="val mono">${esc(pay.bic)}</div></div>` : ''}
    </div>
  </div>

  <div class="advice">
    <div class="advice-title">PAYMENT ADVICE</div>
    <div class="advice-grid">
      <div>
        <div class="advice-to">To: ${esc(brand.tradingName || brand.name)}</div>
        ${brand.address ? `<div class="advice-lines">${esc(brand.address).replace(/\n/g,'<br>')}</div>` : ''}
        ${brand.number ? `<div class="advice-reg">Company Registration No: ${esc(brand.number)}.</div>` : ''}
      </div>
      <div class="advice-right">
        ${box('Customer', invoice.customerName || invoice.clientName)}
        ${box('Invoice Number', invoiceNumber)}
        ${box('Amount Due', `${money(total)}`, true)}
        ${box('Due Date', dt(invoice.dueDate))}
        <div class="advice-enter">Amount Enclosed&nbsp;&nbsp;&nbsp;__________</div>
        <div class="advice-note">Enter the amount you are paying above</div>
      </div>
    </div>
  </div>

  <div class="footline">Thank you for your business.</div>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: cfg.pageSize || 'A4',
      printBackground: true,
      margin: { top: `${cfg.marginMM || 12}mm`, right: `${cfg.marginMM || 12}mm`, bottom: `${cfg.marginMM || 12}mm`, left: `${cfg.marginMM || 12}mm` }
    });
    if (!pdfBuffer || !pdfBuffer.length) throw new Error('Generated PDF is empty');
    return pdfBuffer;
  } finally {
    await browser.close();
  }
};

exports.generateInvoicePDF = generateInvoicePDF;

/* ---------------------------- Xero line items ----------------------------- */
const createXeroLineItems = (items) => {
  if (Array.isArray(items)) {
    return items.map(item => ({
      description: item.description || 'Product/Service',
      quantity: item.quantity || 1,
      unitAmount: item.unitAmount || item.amount || item.unitPrice || 0,
      accountCode: item.accountCode || '200',
      taxAmount: item.taxAmount || 0,
      lineAmount: item.lineAmount || (item.quantity || 1) * (item.unitAmount || item.amount || item.unitPrice || 0)
    }));
  }
  return [{
    description: 'Invoice item',
    quantity: 1,
    unitAmount: items.amount || items,
    accountCode: items.accountCode || '200'
  }];
};

/* ------------------------------ Action handler ---------------------------- */

exports.handleInvoiceAction = async (userId, action, params) => {
  const requiredFields = {
    'create_invoice': ['clientName', 'amount'],
    'update_invoice': ['invoiceId'],
    'mark_invoice_paid': ['invoiceId'],
    'pay_invoice': ['invoiceId'],
    'send_invoice': ['invoiceId', 'email'],
    'resend_invoice': ['invoiceId']
  };

  const actionType = action.type || action.action;
  const normalizedActionType =
    actionType === 'pay_invoice' ? 'mark_invoice_paid' :
    actionType === 'resend_invoice' ? 'send_invoice' :
    actionType;

  const missingFields = validateParams(requiredFields[normalizedActionType] || [], params);
  if (missingFields?.length > 0) {
    return { success: false, missingFields, error: `Missing required fields: ${missingFields.join(', ')}` };
  }

  let result = null;
  let emailResult = null;
  let xeroResult = null;

  try {
    switch (normalizedActionType) {
      case 'create_invoice': {
        // Issuer lookup
        const issuer = await getIssuerByPhoneOrUserId(userId, params.phoneNumber);

        // Brand from issuer
        const derivedBrand = params.brand || (issuer ? {
          name: issuer.companyName || issuer.fullName || process.env.COMPANY_NAME,
          tradingName: issuer.tradeType || undefined,
          address: issuer.address || process.env.COMPANY_ADDRESS || undefined,
          email: issuer.email || process.env.COMPANY_EMAIL,
          phone: issuer.phoneNumber || process.env.COMPANY_PHONE,
          number: issuer.companyNumber || process.env.COMPANY_NUMBER,
          vatNumber: issuer.vatNumber || process.env.COMPANY_VAT
        } : undefined);

        // Payment defaults from issuer
        const payDefaults = issuer ? {
          bankName: issuer.bankName,
          bankAddress: issuer.bankAddress,
          accountName: issuer.accountName || issuer.tradeType || issuer.companyName || issuer.fullName,
          accountNumber: issuer.accountNumber,
          sortCode: issuer.sortCode,
          iban: issuer.iban,
          swiftBIC: issuer.swiftBIC,
          paymentReference: issuer.paymentReference,
          paymentMethod: issuer.paymentMethod || 'BACs'
        } : {};

        const persistedLogoUrl = params.logoUrl || params.logoDataUrl ? params.logoUrl : DEFAULT_LOGO_URL;

        // Precompute a provisional reference (will finalize after create using _id)
        const provisionalRef = params.paymentReference
          || payDefaults.paymentReference
          || buildReference({ invoice: { clientName: params.clientName, accountName: payDefaults.accountName, date: params.date || new Date(), _id: 'XXXXXX' } });

        // Create invoice with issuer-derived business and payment fields
        const invoiceData = {
          clientName: params.clientName,
          clientEmail: params.email || params.clientEmail || undefined,
          clientAddress: params.clientAddress || undefined,
          amount: Number(params.amount) || 0,
          description: params.description || '',
          tasks: Array.isArray(params.tasks) ? params.tasks : [],
          items: Array.isArray(params.items) ? params.items : [],

          reverseCharge: !!params.reverseCharge,
          vatPercent: typeof params.vatPercent === 'number' ? params.vatPercent : undefined,
          taxRate: typeof params.taxRate === 'number' ? params.taxRate : undefined,
          taxAmount: typeof params.taxAmount === 'number' ? params.taxAmount : undefined,

          brand: derivedBrand,
          businessName: derivedBrand?.name,
          businessEmail: derivedBrand?.email,
          businessPhone: derivedBrand?.phone,
          businessAddress: derivedBrand?.address,
          companyNumber: derivedBrand?.number,
          vatNumber: derivedBrand?.vatNumber,

          logoDataUrl: params.logoDataUrl || undefined,
          logoUrl: persistedLogoUrl || undefined,

          currency: params.currency || 'GBP',
          bankName: params.bankName ?? payDefaults.bankName ?? 'Natwest',
          bankAddress: params.bankAddress ?? payDefaults.bankAddress,
          accountName: params.accountName ?? payDefaults.accountName ?? (derivedBrand?.tradingName || derivedBrand?.name),
          accountNumber: params.accountNumber ?? payDefaults.accountNumber,
          sortCode: params.sortCode ?? payDefaults.sortCode,
          iban: params.iban ?? payDefaults.iban,
          swiftBIC: params.swiftBIC ?? params.bic ?? params.swift ?? payDefaults.swiftBIC,
          paymentReference: provisionalRef,
          paymentMethod: params.paymentMethod ?? payDefaults.paymentMethod ?? 'BACs',

          date: params.date ? new Date(params.date) : new Date(),
          dueDate: params.dueDate ? new Date(params.dueDate) : addDays(new Date(), 30),
          status: 'Pending',
          user: userId,
          invoiceNumber: params.invoiceNumber || null
        };

        result = await Invoice.create(invoiceData);

        // Finalize reference now that we have result._id
        const finalRef = params.paymentReference
          ? params.paymentReference
          : buildReference({ invoice: result, fallbackClientName: params.clientName });

        if (finalRef !== result.paymentReference || !result.reference) {
          result = await Invoice.findOneAndUpdate(
            { _id: result._id },
            { paymentReference: finalRef, reference: finalRef },
            { new: true }
          );
        }

        // Xero
        const tenantId = XeroService.getTenantId && XeroService.getTenantId();
        if (tenantId) {
          try {
            const xeroInvoiceData = {
              contactName: params.clientName,
              lineItems: createXeroLineItems(params.items || { amount: params.amount, description: params.description, accountCode: params.accountCode }),
              date: (result.date || new Date()).toISOString(),
              dueDate: (result.dueDate || addDays(new Date(), 30)).toISOString(),
              reference: finalRef,
              status: 'AUTHORISED'
            };
            xeroResult = await XeroService.createInvoice(xeroInvoiceData);
            if (xeroResult && xeroResult.invoiceID) {
              result = await Invoice.findOneAndUpdate(
                { _id: result._id },
                { xeroInvoiceId: xeroResult.invoiceID, xeroReference: finalRef, xeroStatus: xeroResult.status },
                { new: true }
              );
            }
          } catch (e) {
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              { xeroSyncError: e?.message || 'Failed to sync with Xero', xeroSyncErrorDetails: JSON.stringify({ response: e?.response?.data }) },
              { new: true }
            );
          }
        }

        if (params.sendEmail || params.email) {
          const emailAddress = params.email || params.sendEmail;
          if (emailAddress) {
            const emailData = generateInvoiceEmail(result, emailAddress);
            emailResult = await sendEmail(emailData);
          }
        }
        break;
      }

      case 'update_invoice': {
        const invoice = await findInvoice(userId, params.invoiceId);
        if (!invoice) throw new Error(`Invoice not found or you don't have permission to update it`);

        let derivedBrand;
        let payDefaults = {};
        if (params.phoneNumber || params.brand) {
          const issuer = await getIssuerByPhoneOrUserId(userId, params.phoneNumber);
          derivedBrand = params.brand || (issuer ? {
            name: issuer.companyName || issuer.fullName || process.env.COMPANY_NAME,
            tradingName: issuer.tradeType || undefined,
            address: issuer.address || process.env.COMPANY_ADDRESS || undefined,
            email: issuer.email || process.env.COMPANY_EMAIL,
            phone: issuer.phoneNumber || process.env.COMPANY_PHONE,
            number: issuer.companyNumber || process.env.COMPANY_NUMBER,
            vatNumber: issuer.vatNumber || process.env.COMPANY_VAT
          } : undefined);

          payDefaults = issuer ? {
            bankName: issuer.bankName,
            bankAddress: issuer.bankAddress,
            accountName: issuer.accountName || issuer.tradeType || issuer.companyName || issuer.fullName,
            accountNumber: issuer.accountNumber,
            sortCode: issuer.sortCode,
            iban: issuer.iban,
            swiftBIC: issuer.swiftBIC,
            paymentReference: issuer.paymentReference,
            paymentMethod: issuer.paymentMethod || 'BACs'
          } : {};
        }

        const updateFields = {};

        if (params.clientName) updateFields.clientName = params.clientName;
        if (params.amount != null) updateFields.amount = Number(params.amount);
        if (params.description !== undefined) updateFields.description = params.description;
        if (params.currency) updateFields.currency = params.currency;

        if (params.date) {
          const d = new Date(params.date);
          if (isNaN(d.getTime())) throw new Error('Invalid date format');
          updateFields.date = d;
        }
        if (params.dueDate) {
          const dd = new Date(params.dueDate);
          if (isNaN(dd.getTime())) throw new Error('Invalid due date format');
          updateFields.dueDate = dd;
        }
        if (params.status) {
          updateFields.status = ['Pending', 'Paid', 'Overdue'].includes(params.status) ? params.status : 'Pending';
        }
        if (params.invoiceNumber !== undefined) updateFields.invoiceNumber = params.invoiceNumber;
        if (params.items !== undefined) updateFields.items = params.items;

        if (params.reverseCharge !== undefined) updateFields.reverseCharge = !!params.reverseCharge;
        if (typeof params.vatPercent === 'number') updateFields.vatPercent = params.vatPercent;
        if (typeof params.taxRate === 'number') updateFields.taxRate = params.taxRate;
        if (typeof params.taxAmount === 'number') updateFields.taxAmount = params.taxAmount;

        if (derivedBrand) {
          updateFields.brand = derivedBrand;
          updateFields.businessName = derivedBrand.name;
          updateFields.businessEmail = derivedBrand.email;
          updateFields.businessPhone = derivedBrand.phone;
          updateFields.businessAddress = derivedBrand.address;
          updateFields.companyNumber = derivedBrand.number;
          updateFields.vatNumber = derivedBrand.vatNumber;
        }

        // Bank fields: prefer explicit params, else issuer defaults if provided
        ['bankName','bankAddress','accountName','accountNumber','sortCode','iban','swiftBIC','paymentReference','paymentMethod','currency']
          .forEach(k => {
            if (params[k] !== undefined) {
              updateFields[k] = params[k];
            } else if (payDefaults[k] !== undefined) {
              updateFields[k] = payDefaults[k];
            }
          });

        // Reference: if not explicitly set, regenerate from current invoice state
        if (params.paymentReference !== undefined) {
          updateFields.paymentReference = params.paymentReference;
          updateFields.reference = params.paymentReference;
        } else if (!invoice.paymentReference && !invoice.reference) {
          const ref = buildReference({ invoice: { ...invoice.toObject?.() || invoice, ...updateFields } });
          updateFields.paymentReference = ref;
          updateFields.reference = ref;
        }

        if (params.logoDataUrl !== undefined) updateFields.logoDataUrl = params.logoDataUrl;
        if (params.logoUrl !== undefined) updateFields.logoUrl = params.logoUrl || DEFAULT_LOGO_URL;

        result = await Invoice.findOneAndUpdate(
          { _id: invoice._id },
          updateFields,
          { new: true, runValidators: true }
        );

        if (XeroService.getTenantId && XeroService.getTenantId() && invoice.xeroInvoiceId) {
          try {
            const xeroUpdateData = {
              invoiceID: invoice.xeroInvoiceId,
              contactName: result.clientName,
              lineItems: createXeroLineItems(params.items || result.items || {
                amount: result.amount,
                description: result.description
              }),
              reference: result.paymentReference || result.reference || buildReference({ invoice: result })
            };
            xeroResult = await XeroService.updateInvoice(xeroUpdateData);
            if (xeroResult && xeroResult.status !== invoice.xeroStatus) {
              result = await Invoice.findOneAndUpdate(
                { _id: result._id },
                { xeroStatus: xeroResult.status },
                { new: true }
              );
            }
          } catch (e) {
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              { xeroSyncError: e?.message || 'Failed to sync update with Xero', xeroSyncErrorDetails: JSON.stringify({ response: e?.response?.data }) },
              { new: true }
            );
          }
        }

        if (params.sendEmail || params.email) {
          const emailAddress = params.email || params.sendEmail;
          if (emailAddress) {
            const emailData = generateInvoiceEmail(result, emailAddress);
            emailResult = await sendEmail(emailData);
          }
        }
        break;
      }

      case 'mark_invoice_paid': {
        const invoiceToMark = await findInvoice(userId, params.invoiceId);
        if (!invoiceToMark) throw new Error(`Invoice not found or you don't have permission to update it`);

        result = await Invoice.findOneAndUpdate(
          { _id: invoiceToMark._id },
          { status: 'Paid', paidDate: new Date(), dueDate: invoiceToMark.dueDate },
          { new: true, runValidators: true }
        );
        break;
      }

      case 'send_invoice': {
        const invoiceToSend = await findInvoice(userId, params.invoiceId);
        if (!invoiceToSend) throw new Error(`Invoice not found or you don't have permission to access it`);

        const emailData = generateInvoiceEmail(invoiceToSend, params.email);
        const pdfBuffer = await generateInvoicePDF(invoiceToSend, { logoUrl: invoiceToSend.logoUrl || DEFAULT_LOGO_URL });

        emailData.attachments = [{
          filename: `invoice-${invoiceToSend.invoiceNumber || invoiceToSend._id}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }];

        emailResult = await sendEmail(emailData);

        result = await Invoice.findOneAndUpdate(
          { _id: invoiceToSend._id },
          { lastSent: new Date(), sentTo: params.email, status: invoiceToSend.status === 'Draft' ? 'Pending' : invoiceToSend.status },
          { new: true }
        );
        break;
      }

      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }

    return {
      success: true,
      data: result,
      ...(emailResult && { emailStatus: emailResult }),
      ...(xeroResult && { xeroInvoice: xeroResult })
    };
  } catch (error) {
    console.error('[invoice:action:error]', error?.message);
    throw error;
  }
};

/* --------------------------------- Helpers -------------------------------- */
function validateParams(requiredFields, providedParams) {
  if (!requiredFields || requiredFields.length === 0) return null;
  const missingFields = requiredFields.filter(field => {
    const isMissing =
      providedParams[field] === undefined ||
      providedParams[field] === null ||
      (typeof providedParams[field] === 'string' && providedParams[field].trim() === '');
    return isMissing;
  });
  return missingFields.length > 0 ? missingFields : null;
}
