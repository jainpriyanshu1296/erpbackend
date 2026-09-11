/**
 * Tally Prime / Tally.ERP 9 XML Export Service
 * Generates valid Tally XML for Sales Vouchers, Purchase Vouchers, and Ledger Masters.
 */

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTallyDate(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Generate Tally XML for Sales Vouchers
 */
function generateSalesXml(companyName, invoices, invoiceLinesMap = {}) {
  let vouchersXml = '';

  for (const inv of invoices) {
    const vDate = formatTallyDate(inv.invoice_date);
    const vNum = escapeXml(inv.invoice_number);
    const partyName = escapeXml(inv.customer_name || 'Cash Sales');
    const totalAmount = Number(inv.total_amount || 0).toFixed(2);
    const lines = invoiceLinesMap[inv.id] || [];

    let taxableTotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;

    for (const line of lines) {
      taxableTotal += Number(line.taxable || 0);
      cgstTotal += Number(line.cgst || 0);
      sgstTotal += Number(line.sgst || 0);
      igstTotal += Number(line.igst || 0);
    }

    if (lines.length === 0) {
      taxableTotal = totalAmount;
    }

    vouchersXml += `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${vDate}</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${vNum}</VOUCHERNUMBER>
            <REFERENCE>${vNum}</REFERENCE>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <PARTYNAME>${partyName}</PARTYNAME>
            <BASICBUYERNAME>${partyName}</BASICBUYERNAME>
            <FBTPAYMENTTYPE>Default</FBTPAYMENTTYPE>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            <!-- Debtor Entry (Party) -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${partyName}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <!-- Sales Account Credit -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Sales Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${taxableTotal.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;

    if (cgstTotal > 0) {
      vouchersXml += `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Output CGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${cgstTotal.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
    }
    if (sgstTotal > 0) {
      vouchersXml += `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Output SGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${sgstTotal.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
    }
    if (igstTotal > 0) {
      vouchersXml += `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Output IGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${igstTotal.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
    }

    vouchersXml += `
          </VOUCHER>
        </TALLYMESSAGE>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${vouchersXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Generate Tally XML for Purchase Bills
 */
function generatePurchaseXml(companyName, orders) {
  let vouchersXml = '';

  for (const po of orders) {
    const vDate = formatTallyDate(po.created_at);
    const vNum = escapeXml(po.po_number);
    const partyName = escapeXml(po.vendor_name || 'Sundry Creditors');
    const totalAmount = Number(po.total_amount || 0).toFixed(2);

    vouchersXml += `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${vDate}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${vNum}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <!-- Purchase Debit -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Purchase Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <!-- Vendor Credit -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${partyName}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${totalAmount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${vouchersXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Generate Tally XML for Masters (Customers & Vendors)
 */
function generateMastersXml(companyName, customers = [], vendors = []) {
  let ledgersXml = '';

  for (const c of customers) {
    ledgersXml += `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(c.company_name)}" ACTION="Create">
            <NAME>${escapeXml(c.company_name)}</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <PARTYGSTIN>${escapeXml(c.gstin || '')}</PARTYGSTIN>
            <LEDSTATENAME>${escapeXml(c.state || '')}</LEDSTATENAME>
          </LEDGER>
        </TALLYMESSAGE>`;
  }

  for (const v of vendors) {
    ledgersXml += `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(v.company_name)}" ACTION="Create">
            <NAME>${escapeXml(v.company_name)}</NAME>
            <PARENT>Sundry Creditors</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <PARTYGSTIN>${escapeXml(v.gstin || '')}</PARTYGSTIN>
            <LEDSTATENAME>${escapeXml(v.state || '')}</LEDSTATENAME>
          </LEDGER>
        </TALLYMESSAGE>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${ledgersXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

module.exports = {
  generateSalesXml,
  generatePurchaseXml,
  generateMastersXml
};
