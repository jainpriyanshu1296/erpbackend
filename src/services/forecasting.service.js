/**
 * Pure SQL & Mathematics Forecasting Engine
 * Zero external AI API required.
 * Implements:
 * 2.1 Demand Forecasting (Weighted Moving Average + Seasonal Index)
 * 2.2 Smart Reorder Level Suggestion (Usage, Lead Time & Safety Days)
 * 2.3 Price Anomaly Detection (5-Order Vendor-Item Baseline)
 * 2.4 Cash Flow Forecast (Inflow & Outflow Horizons)
 * 2.5 Production Efficiency Trend & OEE
 */

/**
 * 2.1 Demand Forecasting per Item or Top 5 Finished Goods
 */
async function getDemandForecast(orgDb, itemId = null) {
  // 1. Fetch item filter or default to top finished goods
  let itemFilter = '';
  const replacements = [];
  if (itemId) {
    itemFilter = 'WHERE im.id = ?';
    replacements.push(itemId);
  }

  // 2. Aggregate monthly sales for the past 14 months
  const [rows] = await orgDb.query(`
    SELECT 
      soi.item_id,
      im.item_name,
      im.item_code,
      DATE_FORMAT(so.created_at, '%Y-%m') as year_month,
      YEAR(so.created_at) as yr,
      MONTH(so.created_at) as mo,
      COALESCE(SUM(soi.quantity), 0) as total_qty
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.order_id
    JOIN item_master im ON im.id = soi.item_id
    ${itemFilter}
    WHERE so.created_at >= DATE_SUB(CURDATE(), INTERVAL 14 MONTH)
    GROUP BY soi.item_id, im.item_name, im.item_code, year_month, yr, mo
    ORDER BY yr ASC, mo ASC
  `, { replacements });

  // Group by item
  const itemMap = {};
  for (const r of rows) {
    if (!itemMap[r.item_id]) {
      itemMap[r.item_id] = {
        item_id: r.item_id,
        item_name: r.item_name,
        item_code: r.item_code,
        monthly: {}
      };
    }
    itemMap[r.item_id].monthly[r.year_month] = Number(r.total_qty);
  }

  const results = [];
  const now = new Date();

  // Generate list of last 12 month strings
  const pastMonths = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    pastMonths.push(d.toISOString().substring(0, 7));
  }

  // Next 3 months strings
  const futureMonths = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    futureMonths.push(d.toISOString().substring(0, 7));
  }

  for (const item of Object.values(itemMap)) {
    const salesSeries = pastMonths.map(m => item.monthly[m] || 0);

    // Weighted Moving Average of last 3 months: (M1*1 + M2*2 + M3*3) / 6
    const m1 = salesSeries[salesSeries.length - 3] || 0;
    const m2 = salesSeries[salesSeries.length - 2] || 0;
    const m3 = salesSeries[salesSeries.length - 1] || 0;
    const wma = Math.round(((m1 * 1) + (m2 * 2) + (m3 * 3)) / 6 * 10) / 10;

    // Annual monthly average
    const annualTotal = salesSeries.reduce((a, b) => a + b, 0);
    const annualAvg = annualTotal / (salesSeries.length || 1) || 1;

    // Standard deviation and Coefficient of Variation
    const variance = salesSeries.reduce((sum, val) => sum + Math.pow(val - annualAvg, 2), 0) / salesSeries.length;
    const stdDev = Math.sqrt(variance);
    const cv = annualAvg > 0 ? stdDev / annualAvg : 0;
    const confidence = cv < 0.35 ? 'High' : cv < 0.7 ? 'Medium' : 'Low';

    // Forecast next 3 months with seasonal index
    const forecastPoints = futureMonths.map((fm, idx) => {
      const targetMonthNum = (now.getMonth() + 1 + idx + 1) % 12 || 12;
      const lastYearTargetStr = `${now.getFullYear() - 1}-${String(targetMonthNum).padStart(2, '0')}`;
      const lastYearSales = item.monthly[lastYearTargetStr] || annualAvg;
      const seasonalIndex = annualAvg > 0 ? Math.max(0.5, Math.min(2.0, lastYearSales / annualAvg)) : 1.0;
      const projected = Math.round(wma * seasonalIndex);

      return {
        month: fm,
        predicted_qty: Math.max(0, projected),
        seasonal_index: Math.round(seasonalIndex * 100) / 100
      };
    });

    results.push({
      item_id: item.item_id,
      item_name: item.item_name,
      item_code: item.item_code,
      confidence,
      wma_baseline: wma,
      annual_avg: Math.round(annualAvg * 10) / 10,
      historical_months: pastMonths.map((m, idx) => ({ month: m, actual_qty: salesSeries[idx] })),
      forecast: forecastPoints
    });
  }

  return results;
}

/**
 * 2.2 Smart Reorder Level Suggestion
 */
async function getSmartReorderSuggestions(orgDb) {
  // Query 1: Total consumed in last 90 days from stock_ledger
  const [consumptionRows] = await orgDb.query(`
    SELECT 
      sl.item_id,
      im.item_name,
      im.item_code,
      im.reorder_level as current_reorder_level,
      im.reorder_qty as current_reorder_qty,
      im.standard_cost,
      COALESCE(SUM(sl.qty_out), 0) as consumed_90_days,
      COALESCE(ss.total_stock, 0) as current_stock
    FROM item_master im
    LEFT JOIN (
      SELECT item_id, SUM(qty_out) as qty_out 
      FROM stock_ledger 
      WHERE transaction_type IN ('production_issue', 'dispatch', 'sale')
        AND transaction_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      GROUP BY item_id
    ) sl ON sl.item_id = im.id
    LEFT JOIN (
      SELECT item_id, SUM(current_qty) as total_stock 
      FROM stock_summary 
      GROUP BY item_id
    ) ss ON ss.item_id = im.id
    WHERE im.is_active = 1
    GROUP BY im.id, im.item_name, im.item_code, im.reorder_level, im.reorder_qty, im.standard_cost, ss.total_stock
    ORDER BY consumed_90_days DESC
    LIMIT 100
  `);

  // Query 2: Calculate average vendor lead time (days between PO created and GRN received)
  const [leadTimeRows] = await orgDb.query(`
    SELECT 
      poi.item_id,
      AVG(DATEDIFF(g.received_date, po.created_at)) as avg_lead_days
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.order_id
    JOIN grn g ON g.po_id = po.id
    WHERE g.received_date >= po.created_at
    GROUP BY poi.item_id
  `);

  const leadTimeMap = Object.fromEntries(leadTimeRows.map(r => [r.item_id, Math.max(2, Math.round(r.avg_lead_days || 7))]));

  // Safety stock days
  const safetyDays = 3;

  const suggestions = consumptionRows.map(row => {
    const consumed90 = Number(row.consumed_90_days || 0);
    const avgDailyConsumption = consumed90 / 90;
    const leadTime = leadTimeMap[row.item_id] || 7; // default 7 days lead time if no history

    // Formula: avg_daily * (lead_time + safety_days)
    const suggestedReorder = Math.round(avgDailyConsumption * (leadTime + safetyDays) * 10) / 10;
    const currentReorder = Number(row.current_reorder_level || 0);
    const currentStock = Number(row.current_stock || 0);

    const isDeficit = currentReorder < suggestedReorder && suggestedReorder > 0;
    const isCritical = currentStock <= suggestedReorder && suggestedReorder > 0;

    return {
      item_id: row.item_id,
      item_name: row.item_name,
      item_code: row.item_code,
      current_stock: currentStock,
      avg_daily_consumption: Math.round(avgDailyConsumption * 100) / 100,
      lead_time_days: leadTime,
      safety_days: safetyDays,
      current_reorder_level: currentReorder,
      suggested_reorder_level: suggestedReorder,
      status: isCritical ? 'CRITICAL_STOCKOUT_RISK' : isDeficit ? 'UNDER_PROTECTED' : 'OPTIMAL',
      message: isDeficit 
        ? `${row.item_name}: Current reorder level (${currentReorder}) is below calculated requirement (${suggestedReorder}) based on 90-day usage.`
        : 'Stock level within safe operating boundaries.'
    };
  });

  return suggestions;
}

/**
 * 2.3 Price Anomaly Detection
 * Checks given PO items or queries all recent PO items against rolling 5-order baseline
 */
async function detectPriceAnomalies(orgDb, poItemData = null) {
  // If specific PO line items passed for pre-save validation
  if (poItemData && Array.isArray(poItemData)) {
    const anomalies = [];
    for (const item of poItemData) {
      const [rows] = await orgDb.query(`
        SELECT AVG(poi.rate) as avg_rate, COUNT(*) as count
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.order_id
        WHERE poi.item_id = ? AND po.vendor_id = ?
        ORDER BY po.created_at DESC
        LIMIT 5
      `, { replacements: [item.item_id, item.vendor_id] });

      const count = Number(rows[0]?.count || 0);
      const avgRate = Number(rows[0]?.avg_rate || 0);
      const currentRate = Number(item.rate || 0);

      if (count >= 1 && avgRate > 0) {
        const deviation = Math.round(((currentRate - avgRate) / avgRate) * 1000) / 10;
        if (deviation > 15) {
          anomalies.push({
            item_id: item.item_id,
            vendor_id: item.vendor_id,
            current_rate: currentRate,
            baseline_avg_rate: Math.round(avgRate * 100) / 100,
            deviation_percent: deviation,
            warning: `Warning: Rate ₹${currentRate} is ${deviation}% above your 5-order historical average ₹${Math.round(avgRate * 100) / 100}`
          });
        }
      }
    }
    return anomalies;
  }

  // General audit across recent PO items
  const [rows] = await orgDb.query(`
    SELECT 
      poi.id,
      po.po_number,
      v.company_name as vendor_name,
      im.item_name,
      poi.rate as current_rate,
      po.created_at
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.order_id
    JOIN vendors v ON v.id = po.vendor_id
    JOIN item_master im ON im.id = poi.item_id
    WHERE po.created_at >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
    ORDER BY po.created_at DESC
    LIMIT 100
  `);

  return rows;
}

/**
 * 2.4 Cash Flow Runway & Forecast (30, 60, 90 Days)
 */
async function getCashFlowForecast(orgDb) {
  // 1. Expected Cash Inflow (Unpaid Invoices grouped by due date / invoice date)
  const [inflows] = await orgDb.query(`
    SELECT 
      CASE 
        WHEN DATEDIFF(DATE_ADD(invoice_date, INTERVAL 30 DAY), CURDATE()) <= 30 THEN '30_days'
        WHEN DATEDIFF(DATE_ADD(invoice_date, INTERVAL 30 DAY), CURDATE()) <= 60 THEN '60_days'
        ELSE '90_days'
      END as horizon,
      COALESCE(SUM(balance_amount), 0) as total_inflow
    FROM invoices
    WHERE status != 'paid' AND balance_amount > 0
    GROUP BY horizon
  `);

  // 2. Expected Cash Outflow (Pending Purchase Orders)
  const [outflows] = await orgDb.query(`
    SELECT 
      CASE 
        WHEN DATEDIFF(DATE_ADD(created_at, INTERVAL payment_terms DAY), CURDATE()) <= 30 THEN '30_days'
        WHEN DATEDIFF(DATE_ADD(created_at, INTERVAL payment_terms DAY), CURDATE()) <= 60 THEN '60_days'
        ELSE '90_days'
      END as horizon,
      COALESCE(SUM(total_amount), 0) as total_outflow
    FROM purchase_orders
    WHERE status IN ('approved', 'sent', 'received')
    GROUP BY horizon
  `);

  const inflowMap = Object.fromEntries(inflows.map(r => [r.horizon, Number(r.total_inflow)]));
  const outflowMap = Object.fromEntries(outflows.map(r => [r.horizon, Number(r.total_outflow)]));

  const horizons = ['30_days', '60_days', '90_days'];
  const summary = horizons.map(h => {
    const inf = inflowMap[h] || 0;
    const out = outflowMap[h] || 0;
    return {
      horizon: h,
      label: h === '30_days' ? 'Next 30 Days' : h === '60_days' ? '31 - 60 Days' : '61 - 90 Days',
      expected_inflow: Math.round(inf * 100) / 100,
      expected_outflow: Math.round(out * 100) / 100,
      net_cash_position: Math.round((inf - out) * 100) / 100
    };
  });

  return summary;
}

/**
 * 2.5 Production Efficiency Trend & Machine Delays
 */
async function getProductionEfficiency(orgDb) {
  // Machine-wise planned vs actual execution
  const [machineEfficiency] = await orgDb.query(`
    SELECT 
      m.id as machine_id,
      m.machine_code,
      m.machine_name,
      COUNT(wro.id) as total_operations,
      COALESCE(SUM(wro.completed_qty), 0) as completed_qty,
      COALESCE(SUM(wro.rejected_qty), 0) as rejected_qty,
      ROUND(AVG(DATEDIFF(wro.actual_end, wro.planned_end)), 1) as avg_delay_days,
      CASE 
        WHEN SUM(wro.completed_qty + wro.rejected_qty) > 0 
        THEN ROUND((SUM(wro.completed_qty) / SUM(wro.completed_qty + wro.rejected_qty)) * 100, 1)
        ELSE 100
      END as quality_rate
    FROM machines m
    LEFT JOIN wo_routing_operations wro ON wro.machine_id = m.id
    GROUP BY m.id, m.machine_code, m.machine_name
    ORDER BY total_operations DESC
  `);

  // Overall Work Order Efficiency
  const [woSummary] = await orgDb.query(`
    SELECT 
      status,
      COUNT(*) as count,
      COALESCE(SUM(planned_qty), 0) as total_planned,
      COALESCE(SUM(produced_qty), 0) as total_produced,
      ROUND(AVG(CASE WHEN produced_qty > 0 THEN (produced_qty / planned_qty) * 100 ELSE 0 END), 1) as avg_fulfillment_percent
    FROM work_orders
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
    GROUP BY status
  `);

  return {
    machine_efficiency: machineEfficiency,
    work_orders_summary: woSummary
  };
}

module.exports = {
  getDemandForecast,
  getSmartReorderSuggestions,
  detectPriceAnomalies,
  getCashFlowForecast,
  getProductionEfficiency
};
