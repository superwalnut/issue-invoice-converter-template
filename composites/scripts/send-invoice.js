require('dotenv').config();
// Load issue body from file if ISSUE_BODY_FILE is set
if (process.env.ISSUE_BODY_FILE) {
  process.env.ISSUE_BODY = require('fs').readFileSync(process.env.ISSUE_BODY_FILE, 'utf8');
}

const formData = require('form-data');
const Mailgun = require('mailgun.js');
const puppeteer = require('puppeteer');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');

// ─── Init ────────────────────────────────────────────────────────────────────

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const issueNumber = parseInt(process.env.ISSUE_NUMBER);
const issueTitle = process.env.ISSUE_TITLE || '';

// ─── Parse Issue Body ─────────────────────────────────────────────────────────

function parseIssue(rawBody) {
  const body = rawBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const get = (key) => body.match(new RegExp(`\\*\\*${key}:\\*\\*[^\\S\n]*(.+)`))?.[1]?.trim();

  const client   = get('Client');
  const email    = get('Email');
  const phone    = get('Phone');
  const notes    = get('Notes');
  const payment  = get('Payment Method');
  const gst      = get('GST')?.toLowerCase() === 'true';
  const discount = parseFloat(get('Discount') || '0');

  // if dueDate is not provided, default to 4 weeks from today
  var dueDate = get('Due Date');
  if (!dueDate) {
    const defaultDue = new Date();
    defaultDue.setDate(defaultDue.getDate() + 28);
    dueDate = defaultDue.toISOString().split('T')[0];
  }

  console.log('Extracted fields:');
  console.log('client:  ', client);
  console.log('email:   ', email);
  console.log('phone:   ', phone);
  console.log('dueDate: ', dueDate);
  console.log('gst:     ', gst);
  console.log('discount:', discount);
  console.log('notes:   ', notes);
  console.log('payment: ', payment);

  // Parse line items between **Items:** and the next **field**
  const itemsSection = body.match(/\*\*Items:\*\*([\s\S]*?)(\*\*\w|$)/)?.[1] || '';
  const items = itemsSection
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => {
      const match = l.match(/-\s*(.+?)\s*=\s*\$?([\d.]+)/);
      return match
        ? { description: match[1].trim(), amount: parseFloat(match[2]) }
        : null;
    })
    .filter(Boolean);

  const subtotal  = items.reduce((sum, i) => sum + i.amount, 0) - discount;
  const gstAmount = gst ? parseFloat((subtotal * 0.1).toFixed(2)) : 0;
  const total     = parseFloat((subtotal + gstAmount).toFixed(2));

  return {
    client, email, phone, dueDate, notes, payment,
    items, discount, gst, gstAmount, subtotal, total,
  };
}

// ─── Build Invoice HTML ───────────────────────────────────────────────────────

function buildInvoiceHTML(data, invoiceNumber) {
  // ── Colours (configurable via env) ──────────────────────────────────────────
  const colorPrimary = `#${process.env.COMPANY_COLOR_PRIMARY || '22589e'}`;
  const colorbg    = `#${process.env.COMPANY_COLOR_BG    || '1a4a8a'}`;
  const colorText    = `#${process.env.COMPANY_COLOR_TEXT  || '1a1a1d'}`;


  // ── Company info ─────────────────────────────────────────────────────────────
  const companyName       = process.env.COMPANY_NAME         || '';
  const companyWebsite    = process.env.COMPANY_WEBSITE      || '';
  const companyABN        = process.env.COMPANY_ABN          || '';
  const companyLocation   = process.env.COMPANY_LOCATION     || '';
  const companySupportEmail = process.env.COMPANY_SUPPORT_EMAIL || '';

  const bankDetails = process.env.COMPANY_BANK_DETAILS
    ? process.env.COMPANY_BANK_DETAILS
        .replace(/\\n/g, '<br>')      // literal \n from .env
        .replace(/\r?\n/g, '<br>')    // real newlines (e.g. GitHub secrets)
    : '';

  // ── Monogram (first letters of first two words) ───────────────────────────
  const monogram = companyName
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('');

  const today = new Date().toLocaleDateString('en-AU', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const fmt = (n) => `$${parseFloat(n).toFixed(2)}`;

  const itemRows = data.items.map(i => `
    <tr>
      <td class="td-desc">${i.description}</td>
      <td class="td-amount">${fmt(i.amount)}</td>
    </tr>
  `).join('');

  const discountRow = data.discount > 0 ? `
    <tr class="summary-row">
      <td>Discount</td>
      <td class="td-right">-${fmt(data.discount)}</td>
    </tr>
  ` : '';

  const gstRow = data.gst ? `
    <tr class="summary-row">
      <td>GST (10%)</td>
      <td class="td-right">${fmt(data.gstAmount)}</td>
    </tr>
  ` : '';

  const paymentRow = data.payment ? `
    <tr class="summary-row">
      <td>Payment method</td>
      <td class="td-right">${data.payment}</td>
    </tr>
  ` : '';

  const notesBlock = data.notes ? `
    <div class="notes">
      <p class="notes-label">Notes</p>
      <p class="notes-body">${data.notes}</p>
    </div>
  ` : '';

  const bankBlock = bankDetails ? `
    <div style="margin-top: 32px;">
      <p class="client-name">Bank Details</p>
      <p class="meta">${bankDetails}</p>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #333;
      font-size: 14px;
      background: #fff;
    }

    /* ── Header ── */
    .header {
      background: ${colorPrimary};
    }
    .header-topbar {
      background: ${colorbg};
      padding: 10px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-topbar p {
      color: ${colorText};
      font-size: 11px;
      letter-spacing: 1px;
      margin: 0;
    }
    .header-topbar .label {
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    .header-main {
      padding: 28px 40px 32px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .header-company {
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .monogram {
      width: 52px;
      height: 52px;
      border-radius: 10px;
      background: rgba(255,255,255,0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: bold;
      color: #fff;
      flex-shrink: 0;
    }
    .company-name {
      font-size: 20px;
      font-weight: bold;
      color: #fff;
      margin: 0 0 4px;
    }
    .header-meta {
      color: rgba(255,255,255,0.7);
      font-size: 12px;
      margin: 0;
    }
    .invoice-label {
      text-align: right;
    }
    .invoice-label .eyebrow {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: rgba(255,255,255,0.5);
      margin: 0 0 6px;
    }
    .invoice-label .number {
      font-size: 28px;
      font-weight: bold;
      color: #fff;
      letter-spacing: 1px;
      margin: 0 0 4px;
    }
    .invoice-label .date {
      font-size: 12px;
      color: rgba(255,255,255,0.6);
      margin: 0;
    }
    .header-subbar {
      background: ${colorbg};
      padding: 12px 40px;
      display: flex;
      gap: 32px;
      align-items: center;
    }
    .subbar-field p:first-child {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: ${colorText};
      margin: 0 0 2px;
    }
    .subbar-field p:last-child {
      font-size: 13px;
      font-weight: bold;
      color: ${colorText};
      margin: 0;
    }

    /* ── Body ── */
    .body { padding: 32px 40px; }

    /* ── Shared meta ── */
    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #999;
      margin-bottom: 6px;
    }
    .client-name { font-size: 15px; font-weight: bold; color: #1a1a2e; margin-bottom: 2px; }
    .meta { font-size: 12px; color: #414141; margin-top: 2px; }

    .badge-unpaid {
      display: inline-block;
      font-size: 10px;
      padding: 4px 12px;
      border-radius: 20px;
      background: #fff3cd;
      color: #856404;
      font-weight: bold;
      letter-spacing: 0.5px;
    }

    /* ── Line items ── */
    table.items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 0;
    }
    table.items thead tr {
      background: ${colorPrimary};
    }
    table.items thead th {
      padding: 10px 14px;
      font-size: 11px;
      font-weight: bold;
      color: rgba(255,255,255,0.8);
      text-align: left;
      letter-spacing: 0.5px;
    }
    table.items thead th.th-amount { text-align: right; }
    table.items tbody tr {
      border-bottom: 1px solid #f0f0f0;
    }
    table.items tbody tr:nth-child(even) { background: #fafafa; }
    .td-desc   { padding: 12px 14px; color: #333; }
    .td-amount { padding: 12px 14px; text-align: right; color: #333; }

    /* ── Summary totals ── */
    .totals-wrap {
      display: flex;
      justify-content: flex-end;
      margin-top: 0;
    }
    table.summary {
      width: 260px;
      border-collapse: collapse;
      font-size: 13px;
    }
    .summary-row td { padding: 9px 14px; border-bottom: 1px solid #f0f0f0; color: #555; }
    .td-right { text-align: right; }
    .total-row td {
      padding: 12px 14px;
      font-size: 15px;
      font-weight: bold;
      background: ${colorPrimary};
      color: #fff;
    }

    /* ── Notes ── */
    .notes {
      margin-top: 28px;
      padding: 14px 16px;
      background: #f7f7f7;
      border-left: 3px solid ${colorbg};
      border-radius: 0;
    }
    .notes-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #999;
      margin-bottom: 4px;
    }
    .notes-body { font-size: 13px; color: #555; line-height: 1.5; }

    /* ── Footer ── */
    .footer {
      margin-top: 40px;
      padding: 20px 40px 24px;
      border-top: 3px solid ${colorPrimary};
      font-size: 11px;
      color: #aaa;
    }
  </style>
</head>
<body>

  <div class="header">

    <div class="header-topbar">
      <p class="label">Tax Invoice</p>
      <p>ABN ${companyABN}</p>
    </div>

    <div class="header-main">
      <div class="header-company">
        <div class="monogram">${monogram}</div>
        <div>
          <p class="company-name">${companyName}</p>
          <p class="header-meta">${companyWebsite} &nbsp;&middot;&nbsp; ${companyLocation}</p>
        </div>
      </div>
      <div class="invoice-label">
        <p class="eyebrow">Invoice</p>
        <p class="number">#${invoiceNumber}</p>
        <p class="date">${today}</p>
      </div>
    </div>

    <div class="header-subbar">
      <div class="subbar-field">
        <p>Bill to</p>
        <p>${data.client}</p>
      </div>
      <div class="subbar-field">
        <p>Due date</p>
        <p>${data.dueDate}</p>
      </div>
      <div class="subbar-field">
        <p>Amount due</p>
        <p>${fmt(data.total)}</p>
      </div>
      <div style="margin-left: auto;">
        <span class="badge-unpaid">UNPAID</span>
      </div>
    </div>

  </div>

  <div class="body">

    <table class="items">
      <thead>
        <tr>
          <th>Description</th>
          <th class="th-amount">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <div class="totals-wrap">
      <table class="summary">
        <tr class="summary-row">
          <td>Subtotal</td>
          <td class="td-right">${fmt(data.items.reduce((s, i) => s + i.amount, 0))}</td>
        </tr>
        ${discountRow}
        ${gstRow}
        ${paymentRow}
        <tr class="total-row">
          <td>Total due</td>
          <td class="td-right">${fmt(data.total)}</td>
        </tr>
      </table>
    </div>

    ${notesBlock}

    ${bankBlock}

  </div>

  <div class="footer">
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
      <div>
        <p style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin: 0 0 4px;">Questions?</p>
        <a href="mailto:${companySupportEmail}" style="font-size: 12px; color: ${colorPrimary}; text-decoration: none; font-weight: bold;">${companySupportEmail}</a>
      </div>
      <div style="text-align: right;">
        <p style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin: 0 0 4px;">Website</p>
        <a href="https://${companyWebsite}" style="font-size: 12px; color: ${colorPrimary}; text-decoration: none; font-weight: bold;">${companyWebsite}</a>
      </div>
    </div>
    <div style="border-top: 1px solid #eee; padding-top: 12px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <span>${companyName} &nbsp;|&nbsp; ABN ${companyABN} &nbsp;|&nbsp; ${companyLocation}</span>
      <span>Thank you for your business</span>
    </div>
  </div>

</body>
</html>
  `;
}

// ─── Generate PDF ─────────────────────────────────────────────────────────────

async function generatePDF(html, outputPath) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    margin: { top: '15mm', bottom: '15mm', left: '0mm', right: '0mm' },
    printBackground: true,
  });
  await browser.close();
  console.log(`PDF saved to ${outputPath}`);
}

// ─── Send Email via Mailgun ───────────────────────────────────────────────────

async function sendEmail(data, pdfPath, invoiceNumber) {
  const mailgun = new Mailgun(formData);
  const mg = mailgun.client({
    username: 'api',
    key: process.env.MAILGUN_API_KEY,
  });

  const text = [
    `Hi ${data.client},`,
    ``,
    `Please find attached Invoice #${invoiceNumber}.`,
    ``,
    `  Total due:  $${data.total.toFixed(2)}`,
    `  Due date:   ${data.dueDate}`,
    data.payment ? `  Payment:    ${data.payment}` : '',
    ``,
    data.notes ? `Notes: ${data.notes}` : '',
    ``,
    `Thank you for your business!`,
    `${process.env.COMPANY_NAME}`,
  ].filter(l => l !== undefined).join('\n');

  const result = await mg.messages.create(process.env.MAILGUN_DOMAIN, {
    from: `${process.env.COMPANY_NAME} <noreply@${process.env.MAILGUN_DOMAIN}>`,
    to: [data.email],
    subject: `Invoice #${invoiceNumber} — ${data.client}`,
    text,
    attachment: [
      {
        filename: `invoice-${invoiceNumber}.pdf`,
        data: fs.readFileSync(pdfPath),
      },
    ],
  });

  console.log(`Email sent: ${result.id}`);
}

// ─── Post GitHub Comment ──────────────────────────────────────────────────────

async function commentAndClose(data, invoiceNumber) {
  const lines = [
    `### ✅ Invoice #${invoiceNumber} sent`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Client | ${data.client} |`,
    `| Email | ${data.email} |`,
    `| Subtotal | $${data.subtotal.toFixed(2)} |`,
    data.discount > 0 ? `| Discount | -$${data.discount.toFixed(2)} |` : null,
    data.gst ? `| GST (10%) | $${data.gstAmount.toFixed(2)} |` : null,
    `| **Total due** | **$${data.total.toFixed(2)}** |`,
    `| Due date | ${data.dueDate} |`,
    data.payment ? `| Payment method | ${data.payment} |` : null,
  ].filter(Boolean).join('\n');

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: lines,
  });

  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
  });

  console.log(`Issue #${issueNumber} closed.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const body = process.env.ISSUE_BODY;

  if (!body) {
    console.error('ISSUE_BODY is empty');
    process.exit(1);
  }

  const data = parseIssue(body);

  console.log('Raw body:');
  console.log(body);
  console.log('---');
  console.log('Parsed:', JSON.stringify(data, null, 2));

  if (!data.client) { console.error('Missing: Client'); process.exit(1); }
  if (!data.email)  { console.error('Missing: Email');  process.exit(1); }
  if (!data.dueDate){ console.error('Missing: Due Date'); process.exit(1); }
  if (data.items.length === 0) { console.error('Missing: Items'); process.exit(1); }

  console.log(`Generating invoice #${issueNumber} for ${data.client}...`);

  const pdfPath = `/tmp/invoice-${issueNumber}.pdf`;
  const html = buildInvoiceHTML(data, issueNumber);

  await generatePDF(html, pdfPath);

  if (process.env.DRY_RUN === 'true') {
    console.log('--- DRY RUN: skipping email and GitHub API calls ---');
    console.log('Parsed data:', JSON.stringify(data, null, 2));
    console.log(`PDF generated at: ${pdfPath}`);
    return;
  }

  await sendEmail(data, pdfPath, issueNumber);
  await commentAndClose(data, issueNumber);

  console.log('All done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});