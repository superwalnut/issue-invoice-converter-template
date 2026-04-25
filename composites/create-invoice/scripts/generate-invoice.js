require('dotenv').config();

if (process.env.ISSUE_BODY_FILE) {
  process.env.ISSUE_BODY = require('fs').readFileSync(process.env.ISSUE_BODY_FILE, 'utf8');
}

const puppeteer   = require('puppeteer');
const { Octokit } = require('@octokit/rest');
const fs          = require('fs');

const octokit     = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const issueNumber   = parseInt(process.env.ISSUE_NUMBER);

// ─── Parse Issue Body ─────────────────────────────────────────────────────────

function parseIssue(rawBody) {
  const body = rawBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const get  = (key) => body.match(new RegExp(`\\*\\*${key}:\\*\\*[^\\S\n]*(.+)`))?.[1]?.trim();

  const client   = get('Client');
  const emailStr = get('Email');
  const email    = emailStr ? emailStr.split(',').map(e => e.trim()).filter(Boolean) : [];
  const phone    = get('Phone');
  const notes    = get('Notes');
  const payment  = get('Payment Method');
  const gst      = get('GST')?.toLowerCase() === 'true';
  const discount = parseFloat(get('Discount') || '0');
  const invoiceNumber = get('Invoice Number') || issueNumber;

  let dueDate = get('Due Date');
  if (!dueDate) {
    const d = new Date();
    d.setDate(d.getDate() + 28);
    dueDate = d.toISOString().split('T')[0];
  }

  const itemsSection = body.match(/\*\*Items:\*\*([\s\S]*?)(\*\*\w|$)/)?.[1] || '';
  const items = itemsSection
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => {
      const m = l.match(/-\s*(.+?)\s*=\s*\$?([\d.]+)/);
      return m ? { description: m[1].trim(), amount: parseFloat(m[2]) } : null;
    })
    .filter(Boolean);

  const subtotal  = items.reduce((sum, i) => sum + i.amount, 0) - discount;
  const gstAmount = gst ? parseFloat((subtotal * 0.1).toFixed(2)) : 0;
  const total     = parseFloat((subtotal + gstAmount).toFixed(2));

  return { client, email, phone, dueDate, notes, payment, items, discount, gst, gstAmount, subtotal, total, invoiceNumber };
}

// ─── Build Invoice HTML ───────────────────────────────────────────────────────

function buildInvoiceHTML(data, invoiceNumber) {
  const colorPrimary = `#${process.env.COMPANY_COLOR_PRIMARY || '22589e'}`;
  const colorbg      = `#${process.env.COMPANY_COLOR_BG      || '1a4a8a'}`;
  const colorText    = `#${process.env.COMPANY_COLOR_TEXT    || '1a1a1d'}`;

  const companyName         = process.env.COMPANY_NAME          || '';
  const companyWebsite      = process.env.COMPANY_WEBSITE       || '';
  const companyABN          = process.env.COMPANY_ABN           || '';
  const companyLocation     = process.env.COMPANY_LOCATION      || '';
  const companySupportEmail = process.env.COMPANY_SUPPORT_EMAIL || '';
  const bankDetails         = (process.env.COMPANY_BANK_DETAILS || '')
    .replace(/\\n/g, '<br>').replace(/\r?\n/g, '<br>');

  const monogram = companyName.split(' ').slice(0, 2).map(w => w[0]).join('');
  const today    = new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' });
  const fmt      = (n) => `$${parseFloat(n).toFixed(2)}`;

  const itemRows   = data.items.map(i => `<tr><td class="td-desc">${i.description}</td><td class="td-amount">${fmt(i.amount)}</td></tr>`).join('');
  const discountRow = data.discount > 0 ? `<tr class="summary-row"><td>Discount</td><td class="td-right">-${fmt(data.discount)}</td></tr>` : '';
  const gstRow      = data.gst ? `<tr class="summary-row"><td>GST (10%)</td><td class="td-right">${fmt(data.gstAmount)}</td></tr>` : '';
  const paymentRow  = data.payment ? `<tr class="summary-row"><td>Payment method</td><td class="td-right">${data.payment}</td></tr>` : '';
  const notesBlock  = data.notes ? `<div class="notes"><p class="notes-label">Notes</p><p class="notes-body">${data.notes}</p></div>` : '';
  const bankBlock   = bankDetails ? `<div style="margin-top:32px;"><p class="client-name">Bank Details</p><p class="meta">${bankDetails}</p></div>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,Helvetica,sans-serif;color:#333;font-size:14px;background:#fff;}
.header{
  position:relative;
  overflow:hidden;
  background:linear-gradient(135deg,#1f3c88 0%,#3a7bd5 40%,#00c6ff 100%);
}

/* soft glow circle */
.header::before{
  content:'';
  position:absolute;
  top:-120px;
  right:-120px;
  width:320px;
  height:320px;
  background:radial-gradient(circle at center,
      rgba(255,255,255,0.25) 0%,
      rgba(255,255,255,0.08) 40%,
      transparent 70%);
  border-radius:50%;
}

/* subtle diagonal light */
.header::after{
  content:'';
  position:absolute;
  bottom:-140px;
  left:-140px;
  width:360px;
  height:360px;
  background:radial-gradient(circle at center,
      rgba(255,255,255,0.15),
      transparent 70%);
  border-radius:50%;
}

.header-topbar{
  background:rgba(0,0,0,0.15);
  backdrop-filter:blur(4px);
  padding:10px 40px;
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.header-topbar p{
  color:rgba(255,255,255,0.85);
  font-size:11px;
  letter-spacing:1px;
}

.header-main{
  padding:30px 40px 36px;
  display:flex;
  justify-content:space-between;
  align-items:flex-end;
  position:relative;
  z-index:2;
}

.header-company{
  display:flex;
  align-items:center;
  gap:18px;
}

.monogram{
  width:56px;
  height:56px;
  border-radius:14px;
  background:rgba(255,255,255,0.18);
  backdrop-filter:blur(8px);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:22px;
  font-weight:bold;
  color:#fff;
  box-shadow:
    0 8px 20px rgba(0,0,0,0.25),
    inset 0 1px 0 rgba(255,255,255,0.25);
}

.company-name{
  font-size:22px;
  font-weight:700;
  color:#fff;
  letter-spacing:0.3px;
}

.header-meta{
  color:rgba(255,255,255,0.75);
  font-size:12px;
}

.invoice-label{
  text-align:right;
}

.invoice-label .eyebrow{
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:2px;
  color:rgba(255,255,255,0.6);
}

.invoice-label .number{
  font-size:34px;
  font-weight:800;
  color:#fff;
  letter-spacing:1px;
}

.invoice-label .date{
  font-size:12px;
  color:rgba(255,255,255,0.7);
}

/* subbar */
.header-subbar{
  background:rgba(255,255,255,0.15);
  backdrop-filter:blur(6px);
  padding:14px 40px;
  display:flex;
  gap:40px;
  align-items:center;
  position:relative;
  z-index:2;
}

.subbar-field p:first-child{
  font-size:10px;
  text-transform:uppercase;
  letter-spacing:1px;
  color:rgba(255,255,255,0.75);
}

.subbar-field p:last-child{
  font-size:14px;
  font-weight:600;
  color:#fff;
}
.body{padding:32px 40px;}
.client-name{font-size:15px;font-weight:bold;color:#1a1a2e;margin-bottom:2px;}
.meta{font-size:12px;color:#414141;margin-top:2px;}
.badge-unpaid{display:inline-block;font-size:10px;padding:4px 12px;border-radius:20px;background:#fff3cd;color:#da5151;font-weight:bold;letter-spacing:0.5px;}
table.items{width:100%;border-collapse:collapse;}
table.items thead tr{background:${colorPrimary};}
table.items thead th{padding:10px 14px;font-size:11px;font-weight:bold;color:rgba(255,255,255,0.8);text-align:left;letter-spacing:0.5px;}
table.items thead th.th-amount{text-align:right;}
table.items tbody tr{border-bottom:1px solid #f0f0f0;}
table.items tbody tr:nth-child(even){background:#fafafa;}
.td-desc{padding:12px 14px;color:#333;}
.td-amount{padding:12px 14px;text-align:right;color:#333;}
.totals-wrap{display:flex;justify-content:flex-end;}
table.summary{width:260px;border-collapse:collapse;font-size:13px;}
.summary-row td{padding:9px 14px;border-bottom:1px solid #f0f0f0;color:#555;}
.td-right{text-align:right;}
.total-row td{padding:12px 14px;font-size:15px;font-weight:bold;background:${colorPrimary};color:#fff;}
.notes{margin-top:28px;padding:14px 16px;background:#f7f7f7;border-left:3px solid ${colorbg};}
.notes-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:4px;}
.notes-body{font-size:13px;color:#555;line-height:1.5;}
.footer{margin-top:40px;padding:20px 40px 24px;border-top:3px solid ${colorPrimary};font-size:11px;color:#aaa;}
</style></head><body>
<div class="header">
  <div class="header-topbar"><p class="label">Tax Invoice</p><p>ABN ${companyABN}</p></div>
  <div class="header-main">
    <div class="header-company">
      <div class="monogram">${monogram}</div>
      <div><p class="company-name">${companyName}</p><p class="header-meta">${companyWebsite} &nbsp;&middot;&nbsp; ${companyLocation}</p></div>
    </div>
    <div class="invoice-label">
      <p class="eyebrow">Invoice</p><p class="number">#${invoiceNumber}</p><p class="date">${today}</p>
    </div>
  </div>
  <div class="header-subbar">
    <div class="subbar-field"><p>Bill to</p><p>${data.client}</p></div>
    <div class="subbar-field"><p>Due date</p><p>${data.dueDate}</p></div>
    <div class="subbar-field"><p>Amount due</p><p>${fmt(data.total)}</p></div>
    <div style="margin-left:auto;"><span class="badge-unpaid">UNPAID</span></div>
  </div>
</div>
<div class="body">
  <table class="items">
    <thead><tr><th>Description</th><th class="th-amount">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="totals-wrap">
    <table class="summary">
      <tr class="summary-row"><td>Subtotal</td><td class="td-right">${fmt(data.items.reduce((s,i)=>s+i.amount,0))}</td></tr>
      ${discountRow}${gstRow}${paymentRow}
      <tr class="total-row"><td>Total due</td><td class="td-right">${fmt(data.total)}</td></tr>
    </table>
  </div>
  ${notesBlock}${bankBlock}
</div>
<div class="footer">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
    <div>
      <p style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;margin:0 0 4px;">Questions?</p>
      <a href="mailto:${companySupportEmail}" style="font-size:12px;color:${colorPrimary};text-decoration:none;font-weight:bold;">${companySupportEmail}</a>
    </div>
    <div style="text-align:right;">
      <p style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;margin:0 0 4px;">Website</p>
      <a href="https://${companyWebsite}" style="font-size:12px;color:${colorPrimary};text-decoration:none;font-weight:bold;">${companyWebsite}</a>
    </div>
  </div>
  <div style="border-top:1px solid #eee;padding-top:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
    <span>${companyName} &nbsp;|&nbsp; ABN ${companyABN} &nbsp;|&nbsp; ${companyLocation}</span>
    <span>Thank you for your business</span>
  </div>
</div>
</body></html>`;
}

// ─── Generate PDF ─────────────────────────────────────────────────────────────

async function generatePDF(html, outputPath) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outputPath, format: 'A4',
    margin: { top: '15mm', bottom: '15mm', left: '0mm', right: '0mm' },
    printBackground: true,
  });
  await browser.close();
  console.log(`PDF saved to ${outputPath}`);
}

// ─── Commit PDF to Repository ─────────────────────────────────────────────────

async function commitPDFToRepo(pdfPath, data, invoiceNumber) {
  const clientSlug    = data.client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const repoFilePath  = `invoices/${clientSlug}/invoice-${invoiceNumber}.pdf`;
  const base64Content = fs.readFileSync(pdfPath).toString('base64');

  // Resolve the repo's actual default branch so commit and download always agree.
  const { data: repoInfo } = await octokit.repos.get({ owner, repo });
  const branch = repoInfo.default_branch;

  let existingSha;
  try {
    const { data: existing } = await octokit.repos.getContent({ owner, repo, path: repoFilePath, ref: branch });
    existingSha = existing.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner, repo,
    path: repoFilePath,
    message: `invoice: add #${invoiceNumber} for ${data.client}`,
    content: base64Content,
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  console.log(`PDF committed to ${branch}: ${repoFilePath}`);

  // Write path to GITHUB_OUTPUT so the workflow can use it as a job output.
  // Key must match the output name declared in action.yml exactly.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `pdf-path=${repoFilePath}\n`);
  }

  return repoFilePath;
}

// ─── Post Preview Comment ─────────────────────────────────────────────────────

async function postPreviewComment(data, invoiceNumber, repoFilePath) {
  const runUrl  = `https://github.com/${owner}/${repo}/actions`;
  const blobUrl = `https://github.com/${owner}/${repo}/blob/main/${repoFilePath}`;
  const fmt     = (n) => `$${parseFloat(n).toFixed(2)}`;

  const body = [
    `### 📄 Invoice #${invoiceNumber} — Ready for Review`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Client** | ${data.client} |`,
    `| **Email** | ${data.email.join(', ')} |`,
    `| **Subtotal** | ${fmt(data.items.reduce((s,i)=>s+i.amount,0))} |`,
    data.discount > 0 ? `| **Discount** | -${fmt(data.discount)} |` : null,
    data.gst ? `| **GST (10%)** | ${fmt(data.gstAmount)} |` : null,
    `| **Total due** | **${fmt(data.total)}** |`,
    `| **Due date** | ${data.dueDate} |`,
    data.payment ? `| **Payment method** | ${data.payment} |` : null,
    ``,
    `## 👉 [Preview PDF on GitHub](${blobUrl})`,
    ``,
    `---`,
    `To send this invoice, go to the **[Actions run](${runUrl})** and click **Review deployments → Approve**.`,
    `To discard it, click **Reject** — the workflow will stop and no email will be sent.`,
  ].filter(l => l !== null).join('\n');

  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  console.log('Preview comment posted.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const body = process.env.ISSUE_BODY;
  if (!body) { console.error('ISSUE_BODY is empty'); process.exit(1); }

  const data = parseIssue(body);

  if (!data.client)          { console.error('Missing: Client'); process.exit(1); }
  if (!data.items.length)    { console.error('Missing: Items');  process.exit(1); }

  const { invoiceNumber } = data;
  console.log(`Generating invoice #${invoiceNumber} for ${data.client}…`);

  const pdfPath = `/tmp/invoice-${invoiceNumber}.pdf`;
  await generatePDF(buildInvoiceHTML(data, invoiceNumber), pdfPath);

  if (process.env.DRY_RUN === 'true') {
    console.log('DRY RUN — skipping commit and comment');
    return;
  }

  const repoFilePath = await commitPDFToRepo(pdfPath, data, invoiceNumber);
  await postPreviewComment(data, issueNumber, repoFilePath);
  console.log('Done — awaiting environment approval.');
}

main().catch(err => { console.error(err); process.exit(1); });