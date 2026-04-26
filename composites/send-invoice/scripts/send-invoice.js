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
  const emailStr = get('Email');
  const email    = emailStr ? emailStr.split(',').map(e => e.trim()).filter(Boolean) : [];
  const ccStr    = get('CC');
  const cc       = ccStr ? ccStr.split(',').map(e => e.trim()).filter(Boolean) : [];
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

  return { client, email, cc, notes, payment, dueDate, items, discount, gst, gstAmount, subtotal, total, invoiceNumber };
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

// ─── Generate Summary ─────────────────────────────────────────────────────────

async function generateSummary(data) {
  const clientSlug = data.client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const pdfPath = `invoices/${clientSlug}/invoice-${data.invoiceNumber}.pdf`;
  const pdfUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/main/${pdfPath}`;

  const fmt = (n) => `$${parseFloat(n).toFixed(2)}`;

  // Build items table
  let itemsTable = '| Item | Amount |\n|---|---|\n';
  for (const item of data.items) {
    itemsTable += `| ${item.description} | ${fmt(item.amount)} |\n`;
  }

  const summary = [
    `### 📧 Invoice #${data.invoiceNumber} Email Summary`,
    ``,
    `**Email Content:**`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **To** | ${data.email.join(', ')} |`,
    data.cc && data.cc.length > 0 ? `| **CC** | ${data.cc.join(', ')} |` : null,
    `| **Subject** | Invoice #${data.invoiceNumber} — ${data.client} |`,
    `| **Client** | ${data.client} |`,
    `| **Total Due** | **${fmt(data.total)}** |`,
    `| **Due Date** | ${data.dueDate} |`,
    data.payment ? `| **Payment Method** | ${data.payment} |` : null,
    ``,
    `**Items:**`,
    ``,
    itemsTable,
    data.discount > 0 ? `**Discount:** ${fmt(data.discount)}` : null,
    data.gst ? `**GST (10%):** ${fmt(data.gstAmount)}` : null,
    ``,
    `**Notes:** ${data.notes || 'None'}`,
    ``,
    `---`,
    ``,
    `**📄 Invoice PDF:** [${pdfPath}](${pdfUrl})`,
  ].filter(l => l !== null).join('\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = require('fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    console.log('Summary written to GITHUB_STEP_SUMMARY');
  } else {
    console.log('GITHUB_STEP_SUMMARY not available, printing summary:');
    console.log(summary);
  }
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

  const mailOptions = {
    from:    `${process.env.COMPANY_NAME} <noreply@${process.env.MAILGUN_DOMAIN}>`,
    to:      data.email,
    subject: `Invoice #${data.invoiceNumber} — ${data.client}`,
    text,
    attachment: [{ filename: `invoice-${data.invoiceNumber}.pdf`, data: fs.readFileSync(pdfPath) }],
  };

  if (data.cc && data.cc.length > 0) {
    mailOptions.cc = data.cc;
  }

  const result = await mg.messages.create(process.env.MAILGUN_DOMAIN, mailOptions);

  const recipients = data.email.join(', ');
  const ccInfo = data.cc && data.cc.length > 0 ? ` (CC: ${data.cc.join(', ')})` : '';
  console.log(`Email sent to ${recipients}${ccInfo} — ${result.id}`);
}

// ─── Close Issue ──────────────────────────────────────────────────────────────

async function closeIssue(data) {
  const fmt  = (n) => `$${parseFloat(n).toFixed(2)}`;
  const body = [
    `### ✅ Invoice #${data.invoiceNumber} sent`,
    ``,
    `Emailed to **${data.email.join(', ')}**${data.cc && data.cc.length > 0 ? ` (CC: **${data.cc.join(', ')}**)` : ''} after approval.`,
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

  if (!data.client)        { console.error('Missing: Client'); process.exit(1); }
  if (data.email.length === 0) { console.error('Missing: Email');  process.exit(1); }

  const pdfPath = await downloadPDF(data);

  // Generate summary (works in both dry-run and normal mode)
  await generateSummary(data);

  if (process.env.DRY_RUN === 'true') {
    console.log('DRY RUN — skipping email send');
    console.log(`Would send invoice #${data.invoiceNumber} to ${data.email.join(', ')}`);
    return;
  }

  await sendEmail(data, pdfPath);
  await closeIssue(data);
  console.log('All done.');
}

main().catch(err => { console.error(err); process.exit(1); });