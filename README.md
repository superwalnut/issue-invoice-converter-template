# issue-invoice-converter-template
Issue-Invoice Converter is a GitHub Action that automatically transforms GitHub issues into structured business invoices. It allows teams and freelancers who manage client work through GitHub repositories to convert completed issues into professional invoice documents with minimal effort.

## Github Issue Template

**Client:** John Smith
**Email:** john@example.com
**Phone:** +61 400 000 000
**Items:**
- Table tennis coaching session x2 = $100.00
- Video analysis = $50.00
- Match statistics report = $30.00
**Discount:** 0
**GST:** true
**Notes:** some notes you want to provide
**Payment Method:** Bank Transfer

## Test with your .env

# .env
```
DRY_RUN=true
GITHUB_TOKEN=ghp_yourpersonalaccesstoken
GITHUB_REPOSITORY=yourusername/yourrepo
ISSUE_NUMBER=1
ISSUE_TITLE=Invoice - John Smith - April 2026
MAILGUN_API_KEY=your-mailgun-private-api-key
MAILGUN_DOMAIN=mg.yourdomain.com
COMPANY_NAME=sample company name
COMPANY_WEBSITE=https://www.samplecompany.com
COMPANY_ABN=123456789
COMPANY_LOCATION=123 Sample Street, Sample City, Country
COMPANY_SUPPORT_EMAIL=support@samplecompany.com
COMPANY_BANK_DETAILS=Bank: ABC, Acc Name: Sample Company Pty Ltd, Acc BSB: 123456, Acc Number: 12345678
ISSUE_BODY_FILE=./test-issue-body.txt
```

## Run

```
node ./composites/scripts/send-invoice.js
```