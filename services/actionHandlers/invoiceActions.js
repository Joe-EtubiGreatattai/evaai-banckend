const mongoose = require('mongoose');
const { addDays } = require('date-fns');
const puppeteer = require('puppeteer');
const path = require('path');

const Invoice = require('../../models/Invoice');
const sendEmail = require('./../emailService');
const XeroService = require('./xeroService');

/* ----------------------------- Logo utilities ----------------------------- */

// Fetch shim for Node <18
const fetchShim = global.fetch
  ? global.fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Load a remote logo URL into a data URL
async function loadLogoAsDataUrl(url) {
  try {
    const res = await fetchShim(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    let ext = '';
    try {
      ext = (path.extname(new URL(url).pathname) || '').slice(1).toLowerCase();
    } catch (_) { /* ignore */ }

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

// Resolve a logo from several places: explicit data URL > explicit URL > env fallback > tiny SVG
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

  // Minimal fallback SVG
  const FallbackSVG = Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='80' viewBox='0 0 240 80'>
      <rect width='100%' height='100%' rx='10' fill='#ffffff' stroke='#e5e7eb'/>
      <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='22' font-family='Inter, Arial, sans-serif' fill='#111827'>LOGO</text>
     </svg>`
  ).toString('base64');
  return `data:image/svg+xml;base64,${FallbackSVG}`;
}

/* --------------------------------- Search -------------------------------- */

const findInvoice = async (userId, identifier) => {
  console.log('[findInvoice] Called with:', { userId, identifier });

  if (!identifier) {
    console.log('[findInvoice] No identifier provided');
    return null;
  }

  if (mongoose.Types.ObjectId.isValid(identifier)) {
    console.log('[findInvoice] Identifier is a valid ObjectId');
    const invoice = await Invoice.findOne({ _id: identifier, user: userId });
    console.log('[findInvoice] Invoice by ID:', invoice);
    return invoice;
  }

  const amountMatch = identifier.match(/(\$?\d+(\.\d{1,2})?)/);
  if (amountMatch) {
    const amount = parseFloat(amountMatch[1].replace('$', ''));
    console.log('[findInvoice] Identifier matched amount:', amount);
    const amountInvoices = await Invoice.find({
      amount: amount,
      user: userId
    }).sort({ createdAt: -1 }).limit(5);
    console.log('[findInvoice] Invoices by amount:', amountInvoices);
    if (amountInvoices.length > 0) {
      return amountInvoices[0];
    }
  }

  const dateParsed = new Date(identifier);
  if (!isNaN(dateParsed.getTime())) {
    console.log('[findInvoice] Identifier matched date:', dateParsed);
    const dateInvoices = await Invoice.find({
      $or: [{ date: dateParsed }, { dueDate: dateParsed }],
      user: userId
    }).sort({ createdAt: -1 }).limit(5);
    console.log('[findInvoice] Invoices by date:', dateInvoices);
    if (dateInvoices.length > 0) {
      return dateInvoices[0];
    }
  }

  console.log('[findInvoice] Fallback to clientName search');
  const nameInvoices = await Invoice.find({
    clientName: { $regex: new RegExp(identifier, 'i') },
    user: userId
  }).sort({ createdAt: -1 }).limit(5);
  console.log('[findInvoice] Invoices by clientName:', nameInvoices);

  return nameInvoices[0];
};

/* ------------------------------ Email content ----------------------------- */

const generateInvoiceEmail = (invoice, emailAddress) => {
  console.log('[generateInvoiceEmail] Generating email for invoice:', {
    invoiceId: invoice._id,
    clientName: invoice.clientName,
    emailAddress
  });

  const formattedDate = invoice.date ? new Date(invoice.date).toLocaleDateString() : 'N/A';
  const formattedDueDate = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A';
  const formattedAmount = `$${Number(invoice.amount || 0).toFixed(2)}`;
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
${invoice.xeroInvoiceId ? `Xero Invoice ID: ${invoice.xeroInvoiceId}` : ''}

Thank you for your business!
  `;

  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 5px;">
  <h2 style="color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px;">Invoice Details</h2>
  <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 30%;">Client:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.clientName}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Invoice:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoiceIdentifier}</td>
    </tr>
    ${invoice.xeroInvoiceId ? `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Xero ID:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.xeroInvoiceId}</td>
    </tr>` : ''}
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Invoice Date:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${formattedDate}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Due Date:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${formattedDueDate}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Amount:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">${formattedAmount}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Status:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; color: ${statusColor};">${invoice.status}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Description:</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.description || 'N/A'}</td>
    </tr>
  </table>
  <p style="margin-top: 30px; font-style: italic; text-align: center; color: #7f8c8d;">
    Thank you for your business.<br>
    Please contact us if you have any questions about this invoice.
  </p>
</div>`;

  const emailData = {
    to: emailAddress,
    subject: `Invoice ${invoiceIdentifier} from ${invoice.clientName} - ${formattedAmount}`,
    text,
    html
  };

  console.log('[generateInvoiceEmail] Generated email data:', emailData);
  return emailData;
};

/* ------------------------------ PDF generation ---------------------------- */

const generateInvoicePDF = async (invoice, options = {}) => {
  if (!invoice) throw new Error('Invoice data is required');

  const cfg = {
    pageSize: 'A4',
    marginMM: 14,
    currency: invoice.currency || options.currency || 'USD',
    // allow callers or stored invoice fields to set a logo
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

  // Items and totals. If no items, build a single row using description like controller.
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const lineSubtotal = items.length
    ? items.reduce((sum, it) => {
        const qty = Number(it.quantity ?? 1) || 1;
        const unit = Number(it.unitPrice ?? it.unit_price ?? it.unitAmount ?? it.amount ?? 0) || 0;
        return sum + qty * unit;
      }, 0)
    : Number(invoice.subtotal ?? invoice.amount ?? 0) || 0;

  const taxRate = Number(
    invoice.taxRate ??
    (typeof invoice.taxPercent === 'number' ? invoice.taxPercent / 100 : 0)
  ) || 0;

  const taxAmount = Number(invoice.taxAmount ?? lineSubtotal * taxRate) || 0;

  const rawDiscount =
    invoice.discountAmount ??
    (invoice.discountPercent ? (lineSubtotal + taxAmount) * (Number(invoice.discountPercent) / 100) : 0) ?? 0;

  const subtotal = lineSubtotal;
  const totalBeforeDiscount = subtotal + taxAmount;
  const discountAmount = Math.max(0, Number(rawDiscount) || 0);
  const total = Math.max(0, totalBeforeDiscount - discountAmount);

  const invoiceNumber = invoice.invoiceNumber || (invoice._id ? String(invoice._id).slice(-6) : 'INV');

  const brand = {
    name: (invoice.brand && invoice.brand.name) || invoice.businessName || process.env.COMPANY_NAME || 'Your Company',
    tradingName: (invoice.brand && invoice.brand.tradingName) || invoice.tradingName || null,
    address: (invoice.brand && invoice.brand.address) || invoice.businessAddress || process.env.COMPANY_ADDRESS || '',
    email: (invoice.brand && invoice.brand.email) || invoice.businessEmail || process.env.COMPANY_EMAIL || '',
    phone: (invoice.brand && invoice.brand.phone) || invoice.businessPhone || process.env.COMPANY_PHONE || '',
    number: (invoice.brand && invoice.brand.number) || invoice.companyNumber || process.env.COMPANY_NUMBER || '',
  };

  const pay = {
    bankName: invoice.bankName || (invoice.pay && invoice.pay.bankName),
    bankAddress: invoice.bankAddress || (invoice.pay && invoice.pay.bankAddress),
    accountName: invoice.accountName || (invoice.pay && invoice.pay.accountName),
    accountNumber: invoice.accountNumber || (invoice.pay && invoice.pay.accountNumber),
    sortCode: invoice.sortCode || (invoice.pay && invoice.pay.sortCode),
    iban: invoice.iban || (invoice.pay && invoice.pay.iban),
    bic: invoice.swiftBIC || invoice.swift || (invoice.pay && (invoice.pay.bic || invoice.pay.swiftBIC)),
    paymentReference: invoice.paymentReference || (invoice.pay && invoice.pay.paymentReference),
    method: invoice.paymentMethod || (invoice.pay && invoice.pay.method) || 'Bank Transfer',
  };

  const recipientLines = [
    invoice.clientName || invoice.customerName,
    invoice.clientAddress || invoice.customerAddress,
    invoice.clientEmail || invoice.customerEmail
  ].filter(Boolean);

  const rows = (items.length ? items : [{
    description: invoice.description || 'Services rendered',
    quantity: 1,
    unitPrice: subtotal
  }]).map(it => {
    const qty = Number(it.quantity ?? 1) || 1;
    const unit = Number(it.unitPrice ?? it.unit_price ?? it.unitAmount ?? it.amount ?? 0) || 0;
    const amount = qty * unit;
    const desc = esc(String(it.description || 'No description'));
    const unitLabel = it.category || it.unit || 'Units';
    return `<tr>
      <td class="desc">${desc}</td>
      <td class="num">${qty}</td>
      <td class="num">${esc(unitLabel)}</td>
      <td class="num">${money(unit)}</td>
      <td class="num">${money(amount)}</td>
    </tr>`;
  }).join('');

  // Controller-style logo: prefer provided values, then env, then fallback SVG
  const logoDataUrl = await resolveLogoDataUrl({
    logoDataUrl: cfg.logoDataUrl,
    logoUrl: cfg.logoUrl
  });

  const opt = (label, value, mono=false) => {
    if (!value) return '';
    return `<div><div class="muted">${esc(label)}</div><div ${mono ? 'class="mono"' : ''}>${esc(String(value))}</div></div>`;
  };

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(invoiceNumber)} - Invoice</title>
<style>
  @page { size: ${esc(cfg.pageSize || 'A4')}; margin: 0; }
  html, body { height: 100%; margin: 0; }
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; color: #111827; font-size: 12px; -webkit-font-smoothing: antialiased; }
  .page { width: 210mm; min-height: 297mm; background: #fff; position: relative; overflow: hidden; box-sizing: border-box; padding: 16mm 14mm 16mm; }
  .content { display: flex; flex-direction: column; gap: 12px; }
  .biz { display: grid; grid-template-columns: 200px 1fr 1fr; gap: 14px; align-items: stretch; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
  .logoCard { background: #fff; border-radius: 10px; display:grid; place-items:center; min-height: 92px; }
  .logoCard img { width: 150px; height: auto; object-fit: contain; filter: drop-shadow(0 1px 2px rgba(0,0,0,.2)); }
  .bizcol { line-height: 1.45; }
  .bizcol small { color: #6b7280; display:block; margin-bottom: 2px; }
  .title { font-size: 22px; font-weight: 800; letter-spacing: .3px; margin-top: 4px; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px 16px; align-items: start; }
  .summary .block small { color: #6b7280; display:block; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; }
  .items th, .items td { border-bottom: 1px solid #f3f4f6; padding: 8px 6px; font-size: 12px; text-align: left; vertical-align: top; }
  .items th { font-weight: 600; color: #374151; }
  .items .num { text-align: right; white-space: nowrap; }
  .items .desc { width: 52%; }
  .totalRow { display: grid; grid-template-columns: 1fr 320px; gap: 10px; align-items: start; margin-top: 10px; }
  .totalBox { border-top: 1px solid #e5e7eb; padding-top: 8px; display: grid; grid-template-columns: 1fr auto; row-gap: 6px; }
  .totalBox .label { text-align: right; color: #111827; }
  .totalBox .val { text-align: right; font-weight: 700; }
  .paySection { margin-top: 10px; border-top: 1px solid #e5e7eb; padding-top: 10px; }
  .payTitle { font-weight: 700; margin-bottom: 6px; }
  .payGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; }
  .muted { color: #6b7280; font-size: 11px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace; }
  .footer { position: absolute; left: 14mm; right: 14mm; bottom: 10mm; display: grid; grid-template-columns: 1fr auto; font-size: 10.5px; color: #6b7280; }
  .pill { display:inline-block; border:1px solid #e5e7eb; border-radius:999px; padding:6px 12px; font-weight:600; }
</style>
</head>
<body>
  <div class="page">
    <div class="content">
      <div class="biz">
        <div class="logoCard"><img src="${logoDataUrl}" alt="Company logo" /></div>
        <div class="bizcol">
          <small>Registered Business name</small>
          <div><strong>${esc(brand.name)}</strong></div>
          ${brand.address ? `<div>${esc(brand.address)}</div>` : ''}
          ${brand.email ? `<div>${esc(brand.email)}</div>` : ''}
          ${brand.phone ? `<div>${esc(brand.phone)}</div>` : ''}
          ${brand.number ? `<div>Company No - ${esc(brand.number)}</div>` : ''}
        </div>
        <div class="bizcol">
          <small>Trading name</small>
          <div><strong>${esc(brand.tradingName || brand.name)}</strong></div>
        </div>
      </div>

      <div class="title">INVOICE</div>

      <div class="summary">
        <div class="block"><small>Reference</small><div class="pill">${esc(invoiceNumber)}</div></div>
        <div class="block"><small>Amount due</small><div class="mono" style="font-weight:700;">${money(total)}</div></div>
        <div class="block"><small>Due date</small><div>${esc(dt(invoice.dueDate || invoice.due))}</div></div>
        <div class="block"><small>Issue date</small><div>${esc(dt(invoice.date || invoice.issueDate || new Date()))}</div></div>
        <div class="block"><small>To</small><div>${recipientLines.map(esc).join('<br>')}</div></div>
      </div>

      <table class="items">
        <thead>
          <tr><th>Description</th><th class="num">Qty</th><th class="num">Units</th><th class="num">Unit cost</th><th class="num">Amount</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="totalRow">
        <div></div>
        <div class="totalBox">
          <div class="label">Subtotal</div><div class="val">${money(subtotal)}</div>
          ${taxAmount > 0 ? `<div class="label">Tax</div><div class="val">${money(taxAmount)}</div>` : ''}
          ${discountAmount > 0 ? `<div class="label">Discount</div><div class="val">- ${money(discountAmount)}</div>` : ''}
          <div class="label" style="font-weight:700;">Total</div><div class="val" style="font-weight:800;">${money(total)}</div>
        </div>
      </div>

      <div class="paySection">
        <div class="payTitle">PAYMENT DETAILS (${esc(pay.method)})</div>
        <div class="payGrid">
          ${opt('Bank name', pay.bankName)}
          ${opt('Bank address', pay.bankAddress)}
          ${opt('Account name', pay.accountName)}
          ${opt('Account number', pay.accountNumber, true)}
          ${opt('Sort code', pay.sortCode, true)}
          ${opt('IBAN', pay.iban, true)}
          ${opt('BIC/SWIFT', pay.bic, true)}
          ${opt('Payment reference', pay.paymentReference, true)}
          <div style="text-align:right;"><span class="pill">Pay</span></div>
        </div>
      </div>

      ${invoice.notes || invoice.description ? `<div style="margin-top:10px;"><div class="muted">Notes</div><div>${esc(invoice.notes || invoice.description)}</div></div>` : ''}

      <div class="footer">
        <div>Thank you for your business.</div>
        <div>Page 1 of 1</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: cfg.pageSize || 'A4',
      printBackground: true,
      margin: { top: `${cfg.marginMM || 14}mm`, right: `${cfg.marginMM || 14}mm`, bottom: `${cfg.marginMM || 14}mm`, left: `${cfg.marginMM || 14}mm` }
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
  console.log('[createXeroLineItems] Creating line items from:', items);

  if (Array.isArray(items)) {
    const lineItems = items.map(item => ({
      description: item.description || 'Product/Service',
      quantity: item.quantity || 1,
      unitAmount: item.unitAmount || item.amount || 0,
      accountCode: item.accountCode || '200',
      taxAmount: item.taxAmount || 0,
      lineAmount: item.lineAmount || (item.quantity || 1) * (item.unitAmount || item.amount || 0)
    }));
    console.log('[createXeroLineItems] Generated line items array:', lineItems);
    return lineItems;
  }

  // Fallback for single amount invoices
  const lineItem = {
    description: 'Invoice item',
    quantity: 1,
    unitAmount: items.amount || items,
    accountCode: items.accountCode || '200'
  };
  console.log('[createXeroLineItems] Generated single line item:', lineItem);
  return [lineItem];
};

/* ------------------------------ Action handler ---------------------------- */

exports.handleInvoiceAction = async (userId, action, params) => {
  console.log('[handleInvoiceAction] Called with:', {
    userId,
    action: JSON.stringify(action),
    params: JSON.stringify(params)
  });

  const requiredFields = {
    'create_invoice': ['clientName', 'amount'],
    'update_invoice': ['invoiceId'],
    'mark_invoice_paid': ['invoiceId'],
    'pay_invoice': ['invoiceId'],
    'send_invoice': ['invoiceId', 'email'],
    'resend_invoice': ['invoiceId']
  };

  const actionType = action.type || action.action;
  console.log('[handleInvoiceAction] Original action type:', actionType);

  const normalizedActionType =
    actionType === 'pay_invoice' ? 'mark_invoice_paid' :
    actionType === 'resend_invoice' ? 'send_invoice' :
    actionType;

  console.log('[handleInvoiceAction] Normalized action type:', normalizedActionType);

  const missingFields = validateParams(requiredFields[normalizedActionType] || [], params);
  if (missingFields?.length > 0) {
    console.error('[handleInvoiceAction] Missing required fields:', missingFields);
    return {
      success: false,
      missingFields,
      error: `Missing required fields: ${missingFields.join(', ')}`
    };
  }

  let result = null;
  let emailResult = null;
  let xeroResult = null;

  try {
    switch (normalizedActionType) {
      case 'create_invoice': {
        console.log('[handleInvoiceAction] Creating invoice with params:', params);

        // Local invoice
        const invoiceData = {
          clientName: params.clientName,
          clientEmail: params.email || params.clientEmail || undefined,
          clientAddress: params.clientAddress || undefined,
          amount: Number(params.amount) || 0,
          description: params.description || '',
          tasks: Array.isArray(params.tasks) ? params.tasks : [],
          items: Array.isArray(params.items) ? params.items : [],
          taxRate: typeof params.taxRate === 'number' ? params.taxRate : 0,
          date: params.date ? new Date(params.date) : new Date(),
          dueDate: params.dueDate ? new Date(params.dueDate) : addDays(new Date(), 30),
          status: 'Pending',
          user: userId,
          invoiceNumber: params.invoiceNumber || null,
          // optional display + branding for PDF and emails
          brand: params.brand || {
            name: params.businessName || process.env.COMPANY_NAME,
            tradingName: params.tradingName || undefined,
            address: params.businessAddress || process.env.COMPANY_ADDRESS,
            email: params.businessEmail || process.env.COMPANY_EMAIL,
            phone: params.businessPhone || process.env.COMPANY_PHONE,
            number: params.companyNumber || process.env.COMPANY_NUMBER
          },
          logoDataUrl: params.logoDataUrl || undefined,
          logoUrl: params.logoUrl || undefined,
          // banking
          bankName: params.bankName,
          bankAddress: params.bankAddress,
          accountName: params.accountName,
          accountNumber: params.accountNumber,
          sortCode: params.sortCode,
          iban: params.iban,
          swiftBIC: params.swiftBIC || params.bic || params.swift,
          paymentReference: params.paymentReference,
          paymentMethod: params.paymentMethod
        };

        console.log('[handleInvoiceAction] Invoice data prepared:', invoiceData);

        result = await Invoice.create(invoiceData);
        console.log('[handleInvoiceAction] Created invoice:', result);

        // Xero integration if connected
        const tenantId = XeroService.getTenantId && XeroService.getTenantId();
        if (tenantId) {
          console.log('[handleInvoiceAction] Xero connected, creating Xero invoice');
          try {
            const xeroInvoiceData = {
              contactName: params.clientName,
              lineItems: createXeroLineItems(params.items || {
                amount: params.amount,
                description: params.description,
                accountCode: params.accountCode
              }),
              date: (invoiceData.date || new Date()).toISOString(),
              dueDate: (invoiceData.dueDate || addDays(new Date(), 30)).toISOString(),
              reference: params.reference || `INV-${result.invoiceNumber || result._id.toString().slice(-6)}`,
              status: 'AUTHORISED'
            };

            xeroResult = await XeroService.createInvoice(xeroInvoiceData);
            console.log('[handleInvoiceAction] Xero invoice created:', xeroResult);

            if (xeroResult && xeroResult.invoiceID) {
              result = await Invoice.findOneAndUpdate(
                { _id: result._id },
                { xeroInvoiceId: xeroResult.invoiceID, xeroReference: xeroResult.reference, xeroStatus: xeroResult.status },
                { new: true }
              );
            }
          } catch (e) {
            console.error('[handleInvoiceAction] Xero create failed:', e?.message, e?.response?.data);
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              {
                xeroSyncError: e?.message || 'Failed to sync with Xero',
                xeroSyncErrorDetails: JSON.stringify({ response: e?.response?.data })
              },
              { new: true }
            );
          }
        }

        if (params.sendEmail || params.email) {
          const emailAddress = params.email || params.sendEmail;
          if (emailAddress) {
            const emailData = generateInvoiceEmail(result, emailAddress);
            emailResult = await sendEmail(emailData);
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              {
                lastSent: new Date(),
                sentTo: emailAddress,
                status: result.status === 'Draft' ? 'Pending' : result.status
              },
              { new: true }
            );
          }
        }
        break;
      }

      case 'update_invoice': {
        console.log('[handleInvoiceAction] Updating invoice:', params.invoiceId);
        const invoice = await findInvoice(userId, params.invoiceId);

        if (!invoice) {
          console.error('[handleInvoiceAction] Invoice not found or no permission:', params.invoiceId);
          throw new Error(`Invoice not found or you don't have permission to update it`);
        }

        const updateFields = {};

        if (params.clientName) updateFields.clientName = params.clientName;
        if (params.amount != null) updateFields.amount = Number(params.amount);
        if (params.description !== undefined) updateFields.description = params.description;
        if (params.date) {
          updateFields.date = new Date(params.date);
          if (isNaN(updateFields.date.getTime())) throw new Error('Invalid date format');
        }
        if (params.dueDate) {
          updateFields.dueDate = new Date(params.dueDate);
          if (isNaN(updateFields.dueDate.getTime())) throw new Error('Invalid due date format');
        }
        if (params.status) {
          updateFields.status = ['Pending', 'Paid', 'Overdue'].includes(params.status) ? params.status : 'Pending';
        }
        if (params.invoiceNumber !== undefined) updateFields.invoiceNumber = params.invoiceNumber;
        if (params.items !== undefined) updateFields.items = params.items;

        // brand + logo updates
        if (params.brand) updateFields.brand = params.brand;
        if (params.logoDataUrl !== undefined) updateFields.logoDataUrl = params.logoDataUrl;
        if (params.logoUrl !== undefined) updateFields.logoUrl = params.logoUrl;

        // pay details
        ['bankName','bankAddress','accountName','accountNumber','sortCode','iban','swiftBIC','paymentReference','paymentMethod']
          .forEach(k => { if (params[k] !== undefined) updateFields[k] = params[k]; });

        result = await Invoice.findOneAndUpdate(
          { _id: invoice._id },
          updateFields,
          { new: true, runValidators: true }
        );

        // Xero sync if present
        if (XeroService.getTenantId && XeroService.getTenantId() && invoice.xeroInvoiceId) {
          try {
            const xeroUpdateData = {
              invoiceID: invoice.xeroInvoiceId,
              contactName: params.clientName || invoice.clientName,
              lineItems: createXeroLineItems(params.items || invoice.items || {
                amount: params.amount || invoice.amount,
                description: params.description || invoice.description
              }),
              reference: params.reference || invoice.xeroReference || `INV-${result.invoiceNumber || result._id.toString().slice(-6)}`
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
            console.error('[handleInvoiceAction] Xero update failed:', e?.message, e?.response?.data);
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              {
                xeroSyncError: e?.message || 'Failed to sync update with Xero',
                xeroSyncErrorDetails: JSON.stringify({ response: e?.response?.data })
              },
              { new: true }
            );
          }
        }

        if (params.sendEmail || params.email) {
          const emailAddress = params.email || params.sendEmail;
          if (emailAddress) {
            const emailData = generateInvoiceEmail(result, emailAddress);
            emailResult = await sendEmail(emailData);
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              { lastSent: new Date(), sentTo: emailAddress },
              { new: true }
            );
          }
        }
        break;
      }

      case 'mark_invoice_paid': {
        console.log('[handleInvoiceAction] Marking invoice as paid:', params.invoiceId);
        const invoiceToMark = await findInvoice(userId, params.invoiceId);
        if (!invoiceToMark) throw new Error(`Invoice not found or you don't have permission to update it`);

        result = await Invoice.findOneAndUpdate(
          { _id: invoiceToMark._id },
          { status: 'Paid', paidDate: new Date(), dueDate: invoiceToMark.dueDate },
          { new: true, runValidators: true }
        );

        if (XeroService.getTenantId && XeroService.getTenantId() && invoiceToMark.xeroInvoiceId) {
          try {
            xeroResult = await XeroService.markInvoiceAsPaid({
              invoiceID: invoiceToMark.xeroInvoiceId,
              amountPaid: invoiceToMark.amount,
              paymentDate: new Date().toISOString()
            });
            if (xeroResult && xeroResult.status === 'PAID') {
              result = await Invoice.findOneAndUpdate(
                { _id: result._id },
                { xeroStatus: xeroResult.status },
                { new: true }
              );
            }
          } catch (e) {
            console.error('[handleInvoiceAction] Xero mark paid failed:', e?.message, e?.response?.data);
            result = await Invoice.findOneAndUpdate(
              { _id: result._id },
              {
                xeroSyncError: e?.message || 'Failed to sync payment with Xero',
                xeroSyncErrorDetails: JSON.stringify({ response: e?.response?.data })
              },
              { new: true }
            );
          }
        }

        if (params.sendEmail || params.email) {
          const emailAddress = params.email || params.sendEmail;
          if (emailAddress) {
            const emailData = {
              to: emailAddress,
              subject: `Payment Received for Invoice ${result.invoiceNumber ? `#${result.invoiceNumber}` : ''}`,
              text: `We've received your payment of $${Number(result.amount || 0).toFixed(2)} for invoice ${result.invoiceNumber ? `#${result.invoiceNumber}` : ''}. Thank you!`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2 style="color: #2ecc71;">Payment Received</h2>
                  <p>We've received your payment of <strong>$${Number(result.amount || 0).toFixed(2)}</strong> for invoice ${result.invoiceNumber ? `<strong>#${result.invoiceNumber}</strong>` : ''}.</p>
                  <p>Thank you for your business!</p>
                </div>`
            };
            emailResult = await sendEmail(emailData);
          }
        }
        break;
      }

      case 'send_invoice': {
        console.log('[handleInvoiceAction] Sending invoice via email:', params.invoiceId);
        const invoiceToSend = await findInvoice(userId, params.invoiceId);
        if (!invoiceToSend) throw new Error(`Invoice not found or you don't have permission to access it`);

        try {
          const emailData = generateInvoiceEmail(invoiceToSend, params.email);
          const pdfBuffer = await generateInvoicePDF(invoiceToSend);

          emailData.attachments = [{
            filename: `invoice-${invoiceToSend.invoiceNumber || invoiceToSend._id}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }];

          emailResult = await sendEmail(emailData);

          result = await Invoice.findOneAndUpdate(
            { _id: invoiceToSend._id },
            {
              lastSent: new Date(),
              sentTo: params.email,
              status: invoiceToSend.status === 'Draft' ? 'Pending' : invoiceToSend.status
            },
            { new: true }
          );
        } catch (emailError) {
          console.error('[handleInvoiceAction] Error sending invoice email:', emailError?.message, emailError?.response?.data);
          throw new Error('Failed to send invoice email');
        }
        break;
      }

      default:
        console.error('[handleInvoiceAction] Unknown action type:', actionType);
        throw new Error(`Unknown action type: ${actionType}`);
    }

    const response = {
      success: true,
      data: result,
      ...(emailResult && { emailStatus: emailResult }),
      ...(xeroResult && { xeroInvoice: xeroResult })
    };

    console.log('[handleInvoiceAction] Action completed:', response);
    return response;
  } catch (error) {
    console.error('[handleInvoiceAction] Error processing action:', {
      actionType: normalizedActionType,
      error: { message: error.message, stack: error.stack, ...(error.response && { response: error.response.data }) },
      params
    });
    throw error;
  }
};

/* --------------------------------- Helpers -------------------------------- */

function validateParams(requiredFields, providedParams) {
  console.log('[validateParams] Validating fields:', {
    requiredFields,
    providedParams: JSON.stringify(providedParams)
  });

  if (!requiredFields || requiredFields.length === 0) {
    console.log('[validateParams] No required fields to validate');
    return null;
  }

  const missingFields = requiredFields.filter(field => {
    const isMissing =
      providedParams[field] === undefined ||
      providedParams[field] === null ||
      (typeof providedParams[field] === 'string' && providedParams[field].trim() === '');
    if (isMissing) {
      console.log(`[validateParams] Missing required field: ${field}`);
    }
    return isMissing;
  });

  if (missingFields.length > 0) {
    console.log('[validateParams] Missing fields detected:', missingFields);
    return missingFields;
  }

  console.log('[validateParams] All required fields present');
  return null;
}
