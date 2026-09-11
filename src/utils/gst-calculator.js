function calculateGST(items, orgState, customerState) {
  const interstate = orgState && customerState && orgState !== customerState;
  return (items || []).map(item => {
    const taxable = Number(item.qty || item.quantity || 0) * Number(item.rate || item.unit_price || 0) * (1 - Number(item.discount || item.discount_percent || 0) / 100);
    const gst = Number(item.gst_rate || 0);
    const result = { ...item, taxable, igst: interstate ? taxable * gst / 100 : 0, cgst: interstate ? 0 : taxable * gst / 200, sgst: interstate ? 0 : taxable * gst / 200 };
    return { ...result, total: taxable + result.igst + result.cgst + result.sgst };
  });
}
module.exports = { calculateGST };
