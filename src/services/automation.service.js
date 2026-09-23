/**
 * Manufacturing Process Automation Engine
 * Executes autonomous event-driven loops:
 * 1.1 Sales Order Confirmed -> Auto Work Order creation & shop-floor routing
 * 1.2 BOM Explosion -> Raw Material Shortfall -> Auto Purchase Requisition
 * 1.3 Work Order Completed -> Auto-Backflushing (deduct RM, credit scrap, credit FG)
 * 1.4 QC Inspection Saved -> Auto Split (Accepted to main stock, Rejected to quarantine) + Auto Debit Note
 * 1.5 SO Confirmed -> Hard Stock Reservation (Anti Double-Selling)
 * 1.6 Delivery Challan Saved -> Auto Tax Invoice Draft (CGST/SGST vs IGST)
 */

const { v4: uuid } = require('uuid');
const { nextNumber } = require('./erp.service');

/**
 * Fetch automation settings from company_settings (with defaults: all active)
 */
async function getAutomationRules(orgDb) {
  const [rows] = await orgDb.query(`
    SELECT setting_key, setting_value 
    FROM company_settings 
    WHERE setting_key IN (
      'auto_wo_on_so', 
      'auto_pr_on_shortfall', 
      'auto_backflush_on_wo', 
      'auto_qc_debit_note',
      'auto_stock_reserve',
      'auto_invoice_on_dispatch'
    )
  `);

  const settingsMap = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));

  return {
    auto_wo_on_so: settingsMap.auto_wo_on_so !== '0',
    auto_pr_on_shortfall: settingsMap.auto_pr_on_shortfall !== '0',
    auto_backflush_on_wo: settingsMap.auto_backflush_on_wo !== '0',
    auto_qc_debit_note: settingsMap.auto_qc_debit_note !== '0',
    auto_stock_reserve: settingsMap.auto_stock_reserve !== '0',
    auto_invoice_on_dispatch: settingsMap.auto_invoice_on_dispatch !== '0'
  };
}

/**
 * Save updated automation settings to company_settings
 */
async function saveAutomationRules(orgDb, rules = {}) {
  for (const [key, value] of Object.entries(rules)) {
    const valStr = value ? '1' : '0';
    await orgDb.query(`
      INSERT INTO company_settings (setting_key, setting_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE setting_value = ?
    `, { replacements: [key, valStr, valStr] });
  }
  return getAutomationRules(orgDb);
}

/**
 * Trigger 1: When a Sales Order is Confirmed
 * - 1.5 Anti Double-Selling Hard Stock Reservation
 * - 1.1 Auto Work Order Creation for BOM Items
 * - 1.2 BOM Shortfall Calculation -> Auto Purchase Requisition
 */
async function handleSalesOrderConfirmed(orgDb, salesOrderId, userId) {
  const rules = await getAutomationRules(orgDb);

  const [orders] = await orgDb.query('SELECT * FROM sales_orders WHERE id = ?', { replacements: [salesOrderId] });
  if (!orders.length) return { triggered: false, reason: 'ORDER_NOT_FOUND' };
  const order = orders[0];

  const [soItems] = await orgDb.query(`
    SELECT soi.*, im.item_name, im.item_code
    FROM sales_order_items soi
    LEFT JOIN item_master im ON im.id = soi.item_id
    WHERE soi.so_id = ?
  `, { replacements: [salesOrderId] });

  const reservedItems = [];
  const createdWorkOrders = [];
  const shortfallItems = [];

  // 1.5 Anti-Double-Selling: Hard Reserve Stock for Finished Goods
  if (rules.auto_stock_reserve) {
    for (const item of soItems) {
      const neededQty = Number(item.quantity);
      // Query current stock and existing reservations
      const [stocks] = await orgDb.query(`
        SELECT warehouse_id, current_qty, COALESCE(reserved_qty, 0) as reserved_qty
        FROM stock_summary
        WHERE item_id = ? AND (current_qty - COALESCE(reserved_qty, 0)) > 0
        ORDER BY (current_qty - COALESCE(reserved_qty, 0)) DESC
      `, { replacements: [item.item_id] });

      let remainingToReserve = neededQty;
      for (const st of stocks) {
        if (remainingToReserve <= 0) break;
        const available = Math.max(0, Number(st.current_qty) - Number(st.reserved_qty));
        const toReserve = Math.min(available, remainingToReserve);
        if (toReserve > 0) {
          await orgDb.query(`
            UPDATE stock_summary
            SET reserved_qty = COALESCE(reserved_qty, 0) + ?
            WHERE item_id = ? AND warehouse_id = ?
          `, { replacements: [toReserve, item.item_id, st.warehouse_id] });

          remainingToReserve -= toReserve;
          reservedItems.push({
            item_id: item.item_id,
            warehouse_id: st.warehouse_id,
            reserved_qty: toReserve
          });
        }
      }
    }
  }

  // 1.1 & 1.2: Autonomous Work Order & Shortfall PR
  for (const item of soItems) {
    // Check if active BOM exists
    const [boms] = await orgDb.query(`
      SELECT * FROM bom 
      WHERE finished_item_id = ? AND is_active = 1 
      ORDER BY created_at DESC 
      LIMIT 1
    `, { replacements: [item.item_id] });

    if (!boms.length) continue;
    const bom = boms[0];

    // 1.1 Auto-create Work Order
    if (rules.auto_wo_on_so) {
      const [existingWo] = await orgDb.query(
        'SELECT id FROM work_orders WHERE so_id = ? AND so_item_id = ? LIMIT 1',
        { replacements: [salesOrderId, item.id] }
      );

      if (!existingWo.length) {
        const woId = uuid();
        const woNumber = await nextNumber(orgDb, 'work_order', 'WO-', 5);
        await orgDb.query(`
          INSERT INTO work_orders (
            id, wo_number, so_id, so_item_id, finished_item_id,
            bom_id, planned_qty, produced_qty, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'released')
        `, {
          replacements: [
            woId, woNumber, salesOrderId, item.id, item.item_id, 
            bom.id, Number(item.quantity)
          ]
        });

        // Add 6-stage routing operations
        const standardStages = ['Cutting', 'Bending', 'Welding', 'Machining', 'Assembly', 'Quality Check'];
        for (let i = 0; i < standardStages.length; i++) {
          await orgDb.query(`
            INSERT INTO wo_routing_operations (id, wo_id, sequence_no, stage_name, status)
            VALUES (?, ?, ?, ?, 'pending')
          `, { replacements: [uuid(), woId, i + 1, standardStages[i]] });
        }

        createdWorkOrders.push({ id: woId, wo_number: woNumber });

        await orgDb.query(`
          INSERT INTO notifications (id, severity, title, description, source, is_read)
          VALUES (?, 'info', ?, ?, 'automation', 0)
        `, {
          replacements: [
            uuid(),
            `Auto Work Order: ${woNumber}`,
            `WO #${woNumber} auto-created for SO #${order.so_number} (${item.quantity} units of ${item.item_name || 'Item'}).`
          ]
        });
      }
    }

    // 1.2 BOM Shortfall Calculation
    if (rules.auto_pr_on_shortfall) {
      const [bomComponents] = await orgDb.query(`
        SELECT bc.*, im.item_name, im.item_code
        FROM bom_components bc
        JOIN item_master im ON im.id = bc.item_id
        WHERE bc.bom_id = ?
      `, { replacements: [bom.id] });

      for (const comp of bomComponents) {
        const scrapFactor = 1 + (Number(comp.scrap_percent || 0) / 100);
        const requiredQty = Number(comp.quantity) * Number(item.quantity) * scrapFactor;

        // Check live available stock (current_qty - reserved_qty)
        const [stock] = await orgDb.query(`
          SELECT COALESCE(SUM(current_qty - COALESCE(reserved_qty, 0)), 0) AS total_available
          FROM stock_summary
          WHERE item_id = ?
        `, { replacements: [comp.item_id] });

        const availableQty = Number(stock[0]?.total_available || 0);

        if (availableQty < requiredQty) {
          const deficit = Math.round((requiredQty - availableQty) * 1000) / 1000;
          shortfallItems.push({
            item_id: comp.item_id,
            item_name: comp.item_name,
            item_code: comp.item_code,
            required: requiredQty,
            available: availableQty,
            shortfall: deficit,
            rate: comp.rate || 0
          });
        }
      }
    }
  }

  // Auto-Draft Purchase Requisition for total shortfall
  let createdPr = null;
  if (shortfallItems.length > 0 && rules.auto_pr_on_shortfall) {
    const prId = uuid();
    const prNumber = await nextNumber(orgDb, 'purchase_requisition', 'PR-', 5);

    await orgDb.query(`
      INSERT INTO purchase_requisitions (id, pr_number, requested_by, status, notes)
      VALUES (?, ?, ?, 'pending', ?)
    `, {
      replacements: [
        prId, prNumber, userId || null, 
        `Auto-generated material shortfall for confirmed Sales Order #${order.so_number}`
      ]
    });

    for (const item of shortfallItems) {
      await orgDb.query(`
        INSERT INTO purchase_requisition_items (id, requisition_id, item_id, quantity, rate)
        VALUES (?, ?, ?, ?, ?)
      `, { replacements: [uuid(), prId, item.item_id, item.shortfall, item.rate] });
    }

    createdPr = { id: prId, pr_number: prNumber, items_count: shortfallItems.length };

    await orgDb.query(`
      INSERT INTO notifications (id, severity, title, description, source, is_read)
      VALUES (?, 'warning', ?, ?, 'automation', 0)
    `, {
      replacements: [
        uuid(),
        `Material Shortfall: PR #${prNumber}`,
        `${shortfallItems.length} raw material(s) short for SO #${order.so_number}. Purchase requisition auto-drafted.`
      ]
    });
  }

  return {
    triggered: true,
    reserved_items: reservedItems,
    created_work_orders: createdWorkOrders,
    shortfall_pr: createdPr,
    shortfall_items: shortfallItems
  };
}

/**
 * Trigger 2: 1.3 Work Order Completed -> Backflush (Auto Stock Deduction)
 */
async function handleWorkOrderCompleted(orgDb,workOrderId,producedQty,userId) {
  const [[warehouse]]=await orgDb.query('SELECT id FROM warehouses WHERE is_active=1 ORDER BY is_default DESC,id LIMIT 1');
  return require('./salesProduction.service').completeWorkOrder(orgDb,workOrderId,warehouse?.id,userId);
}

/**
 * Trigger 3: 1.4 QC Inspection Saved -> Auto Split & Auto Debit Note
 * - Accepted Qty -> main warehouse stock
 * - Rejected Qty -> quarantine location
 * - If Rejection > 0 -> Auto-draft Debit Note to Vendor
 */
async function handleQcInspectionResult(orgDb, qcInspectionId, userId) {
  return require('./qualityInspection.service').processResult(orgDb,qcInspectionId,{},userId);
}

/**
 * Trigger 4: 1.6 Delivery Challan Saved -> Auto Invoice Draft
 * - Automatically computes CGST/SGST (intra-state) or IGST (inter-state)
 * - Auto-drafts Tax Invoice
 * - Updates SO status to 'dispatched'
 */
async function handleDeliveryChallanSaved(orgDb, challanId, userId) {
  const rules = await getAutomationRules(orgDb);
  if (!rules.auto_invoice_on_dispatch) return { triggered: false };
  try {
    const invoice = await require('./invoice.service').createInvoice(orgDb, { challan_id: challanId }, userId);
    return { triggered: true, ...invoice, invoice_id: invoice.id };
  } catch (cause) {
    if (cause.code === 'INVOICE_CONFLICT') return { triggered: false, reason: cause.message };
    throw cause;
  }
}

module.exports = {
  getAutomationRules,
  saveAutomationRules,
  handleSalesOrderConfirmed,
  handleWorkOrderCompleted,
  handleQcInspectionResult,
  handleDeliveryChallanSaved
};
