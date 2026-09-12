/**
 * Manufacturing Process Automation Service
 * Executes autonomous event-driven loops:
 * 1. Sales Order Confirmed -> Auto Work Order creation
 * 2. BOM Explosion -> Raw Material Shortfall -> Auto Purchase Requisition
 * 3. Work Order Completed -> Auto-Backflushing (deduct raw materials, credit finished goods)
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
      'auto_invoice_on_dispatch'
    )
  `);

  const settingsMap = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));

  return {
    auto_wo_on_so: settingsMap.auto_wo_on_so !== '0',
    auto_pr_on_shortfall: settingsMap.auto_pr_on_shortfall !== '0',
    auto_backflush_on_wo: settingsMap.auto_backflush_on_wo !== '0',
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
 * - Automatically creates Work Order for BOM items
 * - Calculates net material requirement against stock and creates Shortfall PR
 */
async function handleSalesOrderConfirmed(orgDb, salesOrderId, userId) {
  const rules = await getAutomationRules(orgDb);
  if (!rules.auto_wo_on_so && !rules.auto_pr_on_shortfall) return { triggered: false };

  const [orders] = await orgDb.query('SELECT * FROM sales_orders WHERE id = ?', { replacements: [salesOrderId] });
  if (!orders.length) return { triggered: false, reason: 'ORDER_NOT_FOUND' };
  const order = orders[0];

  const [soItems] = await orgDb.query(`
    SELECT soi.*, im.item_name
    FROM sales_order_items soi
    LEFT JOIN item_master im ON im.id = soi.item_id
    WHERE soi.order_id = ?
  `, { replacements: [salesOrderId] });

  const createdWorkOrders = [];
  const shortfallItems = [];

  for (const item of soItems) {
    // 1. Check if an active BOM exists for this finished item
    const [boms] = await orgDb.query(`
      SELECT * FROM bom 
      WHERE finished_item_id = ? AND is_active = 1 
      ORDER BY created_at DESC 
      LIMIT 1
    `, { replacements: [item.item_id] });

    if (!boms.length) continue; // No BOM defined, skip auto-WO
    const bom = boms[0];

    // 2. Auto-create Work Order
    if (rules.auto_wo_on_so) {
      // Check if WO already generated for this SO item
      const [existingWo] = await orgDb.query(
        'SELECT id FROM work_orders WHERE sales_order_id = ? AND so_item_id = ? LIMIT 1',
        { replacements: [salesOrderId, item.id] }
      );

      if (!existingWo.length) {
        const woId = uuid();
        const woNumber = await nextNumber(orgDb, 'work_order', 'WO-', 5);
        await orgDb.query(`
          INSERT INTO work_orders (
            id, wo_number, sales_order_id, so_item_id, finished_item_id, 
            bom_id, planned_qty, produced_qty, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'released')
        `, {
          replacements: [
            woId, woNumber, salesOrderId, item.id, item.item_id, 
            bom.id, Number(item.quantity)
          ]
        });

        // Add standard shop-floor routing stages if none exist
        const standardStages = ['Cutting', 'Bending', 'Welding', 'Machining', 'Assembly', 'Quality Check'];
        for (let i = 0; i < standardStages.length; i++) {
          await orgDb.query(`
            INSERT INTO wo_routing_operations (id, wo_id, sequence_no, stage_name, status)
            VALUES (?, ?, ?, ?, 'pending')
          `, { replacements: [uuid(), woId, i + 1, standardStages[i]] });
        }

        createdWorkOrders.push({ id: woId, wo_number: woNumber });

        // In-app notification
        await orgDb.query(`
          INSERT INTO notifications (id, severity, title, description, source, is_read)
          VALUES (?, 'info', ?, ?, 'automation', 0)
        `, {
          replacements: [
            uuid(),
            `Auto Work Order: ${woNumber}`,
            `Work order auto-generated for Sales Order #${order.so_number} (${item.quantity} units of ${item.item_name || 'Finished Product'}).`
          ]
        });
      }
    }

    // 3. BOM Explosion & Shortfall PR Generation
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

        // Query available inventory
        const [stock] = await orgDb.query(`
          SELECT COALESCE(SUM(current_qty), 0) AS total_qty
          FROM stock_summary
          WHERE item_id = ?
        `, { replacements: [comp.item_id] });

        const currentQty = Number(stock[0]?.total_qty || 0);

        if (currentQty < requiredQty) {
          const deficit = Math.round((requiredQty - currentQty) * 1000) / 1000;
          shortfallItems.push({
            item_id: comp.item_id,
            item_name: comp.item_name,
            item_code: comp.item_code,
            required: requiredQty,
            current: currentQty,
            shortfall: deficit,
            rate: comp.rate || 0
          });
        }
      }
    }
  }

  // 4. Auto-Draft Purchase Requisition for total shortfall
  let createdPr = null;
  if (shortfallItems.length > 0) {
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

    // Notification for purchase department
    await orgDb.query(`
      INSERT INTO notifications (id, severity, title, description, source, is_read)
      VALUES (?, 'warning', ?, ?, 'automation', 0)
    `, {
      replacements: [
        uuid(),
        `Material Shortfall: Auto PR ${prNumber}`,
        `${shortfallItems.length} raw material(s) short for SO #${order.so_number}. Purchase requisition automatically drafted.`
      ]
    });
  }

  return {
    triggered: true,
    created_work_orders: createdWorkOrders,
    shortfall_pr: createdPr,
    shortfall_items: shortfallItems
  };
}

/**
 * Trigger 2: When a Work Order is Completed (Auto-Backflushing)
 * - Consumes raw materials based on BOM consumption formula
 * - Deducts from stock_summary and records production_issue in stock_ledger
 * - Adds produced quantity to finished goods warehouse and logs production_receipt
 */
async function handleWorkOrderCompleted(orgDb, workOrderId, producedQty, userId) {
  const rules = await getAutomationRules(orgDb);
  if (!rules.auto_backflush_on_wo) return { triggered: false };

  const [wos] = await orgDb.query(`
    SELECT wo.*, im.item_name
    FROM work_orders wo
    LEFT JOIN item_master im ON im.id = wo.finished_item_id
    WHERE wo.id = ?
  `, { replacements: [workOrderId] });

  if (!wos.length) return { triggered: false, reason: 'WO_NOT_FOUND' };
  const wo = wos[0];
  const qty = Number(producedQty || wo.planned_qty || 1);

  // Pick warehouse (first default or active warehouse)
  const [whs] = await orgDb.query('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY is_default DESC LIMIT 1');
  const warehouseId = whs.length ? whs[0].id : null;

  const [bomComponents] = await orgDb.query(`
    SELECT bc.*, im.item_name
    FROM bom_components bc
    JOIN item_master im ON im.id = bc.item_id
    WHERE bc.bom_id = ?
  `, { replacements: [wo.bom_id] });

  const tx = await orgDb.transaction();
  try {
    // 1. Consume and deduct each Raw Material (Backflushing)
    for (const comp of bomComponents) {
      const scrapFactor = 1 + (Number(comp.scrap_percent || 0) / 100);
      const consumedQty = Math.round(Number(comp.quantity) * qty * scrapFactor * 1000) / 1000;

      if (warehouseId) {
        // Deduct from stock_summary
        const [existingStock] = await orgDb.query(`
          SELECT current_qty, avg_rate FROM stock_summary 
          WHERE item_id = ? AND warehouse_id = ? 
          FOR UPDATE
        `, { replacements: [comp.item_id, warehouseId], transaction: tx });

        const curr = Number(existingStock[0]?.current_qty || 0);
        const rate = Number(existingStock[0]?.avg_rate || comp.rate || 0);
        const next = Math.max(0, curr - consumedQty);

        await orgDb.query(`
          INSERT INTO stock_summary (item_id, warehouse_id, current_qty, avg_rate, total_value)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE current_qty = ?, total_value = ?
        `, {
          replacements: [comp.item_id, warehouseId, next, rate, next * rate, next, next * rate],
          transaction: tx
        });

        // Record in stock_ledger
        await orgDb.query(`
          INSERT INTO stock_ledger (
            id, item_id, warehouse_id, transaction_type, reference_type, 
            reference_id, qty_out, balance_qty, rate, amount, created_by
          ) VALUES (?, ?, ?, 'production_issue', 'work_order', ?, ?, ?, ?, ?, ?)
        `, {
          replacements: [
            uuid(), comp.item_id, warehouseId, workOrderId, 
            consumedQty, next, rate, consumedQty * rate, userId || null
          ],
          transaction: tx
        });
      }
    }

    // 2. Credit Finished Good into stock
    if (warehouseId && wo.finished_item_id) {
      const [fgStock] = await orgDb.query(`
        SELECT current_qty, avg_rate FROM stock_summary 
        WHERE item_id = ? AND warehouse_id = ? 
        FOR UPDATE
      `, { replacements: [wo.finished_item_id, warehouseId], transaction: tx });

      const fgCurrent = Number(fgStock[0]?.current_qty || 0);
      const fgNext = fgCurrent + qty;

      await orgDb.query(`
        INSERT INTO stock_summary (item_id, warehouse_id, current_qty, avg_rate, total_value)
        VALUES (?, ?, ?, 0, 0)
        ON DUPLICATE KEY UPDATE current_qty = ?
      `, { replacements: [wo.finished_item_id, warehouseId, fgNext, fgNext], transaction: tx });

      await orgDb.query(`
        INSERT INTO stock_ledger (
          id, item_id, warehouse_id, transaction_type, reference_type, 
          reference_id, qty_in, balance_qty, rate, amount, created_by
        ) VALUES (?, ?, ?, 'production_receipt', 'work_order', ?, ?, ?, 0, 0, ?)
      `, {
        replacements: [
          uuid(), wo.finished_item_id, warehouseId, workOrderId, 
          qty, fgNext, userId || null
        ],
        transaction: tx
      });
    }

    // Mark all pending routing operations as completed
    await orgDb.query(`
      UPDATE wo_routing_operations 
      SET status = 'completed', actual_end = NOW() 
      WHERE wo_id = ? AND status != 'completed'
    `, { replacements: [workOrderId], transaction: tx });

    await tx.commit();

    // In-app notification
    await orgDb.query(`
      INSERT INTO notifications (id, severity, title, description, source, is_read)
      VALUES (?, 'info', ?, ?, 'automation', 0)
    `, {
      replacements: [
        uuid(),
        `Backflushed: WO #${wo.wo_number}`,
        `Automatically consumed raw materials and credited ${qty} units of ${wo.item_name || 'finished goods'} into inventory.`
      ]
    });

    return { triggered: true, backflushed_items: bomComponents.length, produced_qty: qty };
  } catch (err) {
    await tx.rollback();
    console.error(`[AUTO BACKFLUSH ERROR] WO ${workOrderId}:`, err.message);
    throw err;
  }
}

module.exports = {
  getAutomationRules,
  saveAutomationRules,
  handleSalesOrderConfirmed,
  handleWorkOrderCompleted
};
