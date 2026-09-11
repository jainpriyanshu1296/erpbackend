const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
async function excel(rows, sheet = 'Report') {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(sheet);
  const data = rows || []; if (data.length) { ws.columns = Object.keys(data[0]).map(k => ({ header: k, key: k })); data.forEach(r => ws.addRow(r)); }
  return wb.xlsx.writeBuffer();
}
function pdf(rows, title = 'Report') {
  return new Promise((resolve, reject) => { const chunks = []; const doc = new PDFDocument(); doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); doc.fontSize(18).text(title).moveDown(); (rows || []).forEach(r => doc.fontSize(9).text(Object.entries(r).map(([k,v]) => `${k}: ${v ?? ''}`).join(' | '))); doc.end(); });
}
module.exports = { excel, pdf };
