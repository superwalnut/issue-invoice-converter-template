require('dotenv').config();

if (process.env.ISSUE_BODY_FILE) {
  process.env.ISSUE_BODY = require('fs').readFileSync(process.env.ISSUE_BODY_FILE, 'utf8');
}

const formData    = require('form-data');
const Mailgun     = require('mailgun.js');
const { Octokit } = require('@octokit/rest');
const fs          = require('fs');

const octokit       = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const issueNumber   = parseInt(process.env.ISSUE_NUMBER);

// ─── Parse Issue Body ─────────────────────────────────────────────────────────

function parseIssue(rawBody) {
  const body = rawBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const get  = (key) => body.match(new RegExp(`\\*\\*${key}:\\*\\*[^\\S\n]*(.+)`))?.[1]?.trim();

  const invoiceNumber = get('Invoice Number') || issueNumber;
  const client   = get('Client');
  const email    = get('Email');
  const notes    = get('Notes');
  const payment  = get('Payment Method');
  const gst      = get('GST')?.toLowerCase() === 'true';
  const discount = parseFloat(get('Discount') || '0');

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

  return { client, email, notes, payment, dueDate, items, discount, gst, gstAmount, subtotal, total, invoiceNumber };
}

// ─── Download committed PDF from repo ────────────────────────────────────────

async function downloadPDF(data) {
  const clientSlug   = data.client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const repoFilePath = `invoices/${clientSlug}/invoice-${data.invoiceNumber}.pdf`;
  const localPath    = `/tmp/invoice-${data.invoiceNumber}.pdf`;

  const { data: file } = await octokit.repos.getContent({ owner, repo, path: repoFilePath });
  fs.writeFileSync(localPath, Buffer.from(file.content, 'base64'));
  console.log(`PDF downloaded from ${repoFilePath}`);
  return localPath;
}

// ─── Send Email ───────────────────────────────────────────────────────────────

async function sendEmail(data, pdfPath) {
  const mg = new Mailgun(formData).client({ username: 'api', key: process.env.MAILGUN_API_KEY });

  const text = [
    `Hi ${data.client},`,
    ``,
    `Please find attached Invoice #${data.invoiceNumber}.`,
    ``,
    `  Total due:  $${data.total.toFixed(2)}`,
    `  Due date:   ${data.dueDate}`,
    data.payment ? `  Payment:    ${data.payment}` : null,
    ``,
    data.notes ? `Notes: ${data.notes}` : null,
    ``,
    `Thank you for your business!`,
    process.env.COMPANY_NAME,
  ].filter(l => l !== null).join('\n');

  const result = await mg.messages.create(process.env.MAILGUN_DOMAIN, {
    from:    `${process.env.COMPANY_NAME} <noreply@${process.env.MAILGUN_DOMAIN}>`,
    to:      [data.email],
    subject: `Invoice #${data.invoiceNumber} — ${data.client}`,
    text,
    attachment: [{ filename: `invoice-${data.invoiceNumber}.pdf`, data: fs.readFileSync(pdfPath) }],
  });

  console.log(`Email sent to ${data.email} — ${result.id}`);
}

// ─── Close Issue ──────────────────────────────────────────────────────────────

async function closeIssue(data) {
  const fmt  = (n) => `$${parseFloat(n).toFixed(2)}`;
  const body = [
    `### ✅ Invoice #${data.invoiceNumber} sent`,
    ``,
    `Emailed to **${data.email}** after approval.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Client** | ${data.client} |`,
    `| **Total due** | **${fmt(data.total)}** |`,
    `| **Due date** | ${data.dueDate} |`,
  ].join('\n');

  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
  console.log(`Issue #${issueNumber} closed.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawBody = process.env.ISSUE_BODY;
  if (!rawBody) { console.error('ISSUE_BODY is empty'); process.exit(1); }

  const data = parseIssue(rawBody);

  if (!data.client) { console.error('Missing: Client'); process.exit(1); }
  if (!data.email)  { console.error('Missing: Email');  process.exit(1); }

  const pdfPath = await downloadPDF(data);

  if (process.env.DRY_RUN === 'true') {
    console.log('DRY RUN — skipping email send');
    console.log(`Would send invoice #${data.invoiceNumber} to ${data.email}`);
    return;
  }

  await sendEmail(data, pdfPath);
  await closeIssue(data);
  console.log('All done.');
}

main().catch(err => { console.error(err); process.exit(1); });