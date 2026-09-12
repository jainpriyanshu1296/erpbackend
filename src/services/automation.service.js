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
    WHERE soi.order_id = ?
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
    // 1. Consume raw materials based on BOM formula
    for (const comp of bomComponents) {
      const scrapFactor = 1 + (Number(comp.scrap_percent || 0) / 100);
      const consumedQty = Math.round(Number(comp.quantity) * qty * scrapFactor * 1000) / 1000;
      const scrapQty = Math.round(Number(comp.quantity) * qty * (Number(comp.scrap_percent || 0) / 100) * 1000) / 1000;

      if (warehouseId) {
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

        // Log production issue in stock_ledger
        await orgDb.query(`
          INSERT INTO stock_ledger (
            id, item_id, warehouse_id, transaction_type, reference_type, 
            reference_id, qty_out, balance_qty, rate, amount, notes, created_by
          ) VALUES (?, ?, ?, 'production_issue', 'work_order', ?, ?, ?, ?, ?, ?, ?)
        `, {
          replacements: [
            uuid(), comp.item_id, warehouseId, workOrderId, 
            consumedQty, next, rate, consumedQty * rate, 
            `Auto-backflushed: ${consumedQty} units (scrap: ${scrapQty})`, userId || null
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
          reference_id, qty_in, balance_qty, rate, amount, notes, created_by
        ) VALUES (?, ?, ?, 'production_receipt', 'work_order', ?, ?, ?, 0, 0, ?, ?)
      `, {
        replacements: [
          uuid(), wo.finished_item_id, warehouseId, workOrderId, 
          qty, fgNext, `Production complete: ${qty} units received`, userId || null
        ],
        transaction: tx
      });
    }

    // Complete all routing operations
    await orgDb.query(`
      UPDATE wo_routing_operations 
      SET status = 'completed', actual_end = NOW() 
      WHERE wo_id = ? AND status != 'completed'
    `, { replacements: [workOrderId], transaction: tx });

    await tx.commit();

    await orgDb.query(`
      INSERT INTO notifications (id, severity, title, description, source, is_read)
      VALUES (?, 'info', ?, ?, 'automation', 0)
    `, {
      replacements: [
        uuid(),
        `Backflushed: WO #${wo.wo_number}`,
        `Automatically consumed raw materials and credited ${qty} units of ${wo.item_name || 'Finished Goods'} into inventory.`
      ]
    });

    return { triggered: true, backflushed_items: bomComponents.length, produced_qty: qty };
  } catch (err) {
    await tx.rollback();
    console.error(`[AUTO BACKFLUSH ERROR] WO ${workOrderId}:`, err.message);
    throw err;
  }
}

/**
 * Trigger 3: 1.4 QC Inspection Saved -> Auto Split & Auto Debit Note
 * - Accepted Qty -> main warehouse stock
 * - Rejected Qty -> quarantine location
 * - If Rejection > 0 -> Auto-draft Debit Note to Vendor
 */
async function handleQcInspectionResult(orgDb, qcInspectionId, userId) {
  const rules = await getAutomationRules(orgDb);

  const [inspections] = await orgDb.query(`
    SELECT qi.*, im.item_name, im.standard_cost
    FROM qc_inspections qi
    LEFT JOIN item_master im ON im.id = qi.item_id
    WHERE qi.id = ?
  `, { replacements: [qcInspectionId] });

  if (!inspections.length) return { triggered: false, reason: 'QC_NOT_FOUND' };
  const qc = inspections[0];

  const accepted = Number(qc.accepted_qty || 0);
  const rejected = Number(qc.rejected_qty || 0);

  // Main warehouse
  const [mainWhs] = await orgDb.query('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY is_default DESC LIMIT 1');
  const mainWhId = mainWhs.length ? mainWhs[0].id : null;

  // 1. Post Accepted Qty to Main Stock
  if (accepted > 0 && mainWhId) {
    const [st] = await orgDb.query(
      'SELECT current_qty, avg_rate FROM stock_summary WHERE item_id = ? AND warehouse_id = ?',
      { replacements: [qc.item_id, mainWhId] }
    );
    const curr = Number(st[0]?.current_qty || 0);
    const rate = Number(st[0]?.avg_rate || qc.standard_cost || 0);
    const next = curr + accepted;

    await orgDb.query(`
      INSERT INTO stock_summary (item_id, warehouse_id, current_qty, avg_rate, total_value)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE current_qty = ?, total_value = ?
    `, { replacements: [qc.item_id, mainWhId, next, rate, next * rate, next, next * rate] });

    await orgDb.query(`
      INSERT INTO stock_ledger (
        id, item_id, warehouse_id, transaction_type, reference_type, 
        reference_id, qty_in, balance_qty, rate, amount, notes, created_by
      ) VALUES (?, ?, ?, 'qc_accepted', 'qc_inspection', ?, ?, ?, ?, ?, 'QC Accepted Stock', ?)
    `, {
      replacements: [uuid(), qc.item_id, mainWhId, qcInspectionId, accepted, next, rate, accepted * rate, userId || null]
    });
  }

  // 2. Post Rejected Qty to Quarantine
  let debitNote = null;
  if (rejected > 0) {
    // Log quarantine movement in stock ledger
    await orgDb.query(`
      INSERT INTO stock_ledger (
        id, item_id, warehouse_id, transaction_type, reference_type, 
        reference_id, qty_out, balance_qty, rate, amount, notes, created_by
      ) VALUES (?, ?, ?, 'quarantine_receipt', 'qc_inspection', ?, ?, 0, ?, ?, 'QC Rejected to Quarantine', ?)
    `, {
      replacements: [
        uuid(), qc.item_id, mainWhId, qcInspectionId, 
        rejected, Number(qc.standard_cost || 0), rejected * Number(qc.standard_cost || 0), userId || null
      ]
    });

    // 3. Auto-Draft Debit Note against Vendor
    if (rules.auto_qc_debit_note) {
      // Find vendor from reference (GRN or PO)
      let vendorId = null;
      if (qc.reference_id) {
        const [grns] = await orgDb.query('SELECT vendor_id FROM grn WHERE id = ?', { replacements: [qc.reference_id] });
        if (grns.length) vendorId = grns[0].vendor_id;
        else {
          const [pos] = await orgDb.query('SELECT vendor_id FROM purchase_orders WHERE id = ?', { replacements: [qc.reference_id] });
          if (pos.length) vendorId = pos[0].vendor_id;
        }
      }

      if (vendorId) {
        const dnId = uuid();
        const dnNumber = await nextNumber(orgDb, 'debit_note', 'DN-', 5);
        const rate = Number(qc.standard_cost || 0);
        const totalAmount = Math.round(rejected * rate * 100) / 100;

        await orgDb.query(`
          INSERT INTO debit_notes (
            id, note_number, vendor_id, reference_type, reference_id, 
            total_amount, reason, status, created_by
          ) VALUES (?, ?, ?, 'qc_inspection', ?, ?, ?, 'draft', ?)
        `, {
          replacements: [
            dnId, dnNumber, vendorId, qcInspectionId, 
            totalAmount, `Auto-generated from QC rejection: ${rejected} units of ${qc.item_name || 'Item'}`, userId || null
          ]
        });

        await orgDb.query(`
          INSERT INTO debit_note_items (id, debit_note_id, item_id, quantity, rate, amount, reason)
          VALUES (?, ?, ?, ?, ?, ?, 'QC Rejection')
        `, { replacements: [uuid(), dnId, qc.item_id, rejected, rate, totalAmount] });

        debitNote = { id: dnId, note_number: dnNumber, amount: totalAmount };

        await orgDb.query(`
          INSERT INTO notifications (id, severity, title, description, source, is_read)
          VALUES (?, 'warning', ?, ?, 'automation', 0)
        `, {
          replacements: [
            uuid(),
            `QC Rejection: Debit Note ${dnNumber}`,
            `${rejected} pcs rejected for ${qc.item_name || 'Item'}. Debit Note #${dnNumber} for ₹${totalAmount} auto-drafted.`
          ]
        });
      }
    }
  }

  return {
    triggered: true,
    accepted_qty: accepted,
    rejected_qty: rejected,
    debit_note: debitNote
  };
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

  const [challans] = await orgDb.query(`
    SELECT dc.*, c.company_name as customer_name, c.state as customer_state, c.gstin as customer_gstin
    FROM delivery_challans dc
    LEFT JOIN customers c ON c.id = dc.customer_id
    WHERE dc.id = ?
  `, { replacements: [challanId] });

  if (!challans.length) return { triggered: false, reason: 'CHALLAN_NOT_FOUND' };
  const challan = challans[0];

  // Fetch company state from company_settings
  const [compStateRows] = await orgDb.query(
    "SELECT setting_value FROM company_settings WHERE setting_key = 'state' LIMIT 1"
  );
  const companyState = (compStateRows[0]?.setting_value || 'Madhya Pradesh').trim().toLowerCase();
  const customerState = (challan.customer_state || companyState).trim().toLowerCase();
  const isInterstate = companyState !== customerState;

  // Fetch challan line items or fallback to sales order items
  let [lines] = await orgDb.query(
    'SELECT * FROM delivery_challan_items WHERE challan_id = ?',
    { replacements: [challanId] }
  );

  if (!lines.length && challan.sales_order_id) {
    const [soItems] = await orgDb.query(`
      SELECT item_id, quantity, rate FROM sales_order_items WHERE order_id = ?
    `, { replacements: [challan.sales_order_id] });
    lines = soItems;
  }

  if (!lines.length) return { triggered: false, reason: 'NO_ITEMS' };

  // Calculate invoice amounts with GST
  let subtotal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  const invoiceLines = [];

  for (const item of lines) {
    // Fetch item GST rate
    const [itemDetails] = await orgDb.query(
      'SELECT item_name, gst_rate FROM item_master WHERE id = ?',
      { replacements: [item.item_id] }
    );
    const gstRate = Number(itemDetails[0]?.gst_rate || 18);
    const lineQty = Number(item.quantity);
    const lineRate = Number(item.rate || 0);
    const taxable = Math.round(lineQty * lineRate * 100) / 100;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (isInterstate) {
      igst = Math.round(taxable * (gstRate / 100) * 100) / 100;
      totalIgst += igst;
    } else {
      cgst = Math.round(taxable * ((gstRate / 2) / 100) * 100) / 100;
      sgst = Math.round(taxable * ((gstRate / 2) / 100) * 100) / 100;
      totalCgst += cgst;
      totalSgst += sgst;
    }

    const lineTotal = taxable + cgst + sgst + igst;
    subtotal += taxable;

    invoiceLines.push({
      item_id: item.item_id,
      description: itemDetails[0]?.item_name || 'Product',
      quantity: lineQty,
      rate: lineRate,
      gst_rate: gstRate,
      taxable,
      cgst,
      sgst,
      igst,
      total: lineTotal
    });
  }

  const grandTotal = Math.round((subtotal + totalCgst + totalSgst + totalIgst) * 100) / 100;
  const invoiceId = uuid();
  const invoiceNumber = await nextNumber(orgDb, 'invoice', 'INV-', 5);

  const tx = await orgDb.transaction();
  try {
    // 1. Create Tax Invoice Header
    await orgDb.query(`
      INSERT INTO invoices (
        id, invoice_number, customer_id, order_id, invoice_date, 
        status, total_amount, balance_amount
      ) VALUES (?, ?, ?, ?, CURDATE(), 'draft', ?, ?)
    `, {
      replacements: [
        invoiceId, invoiceNumber, challan.customer_id, 
        challan.sales_order_id || null, grandTotal, grandTotal
      ],
      transaction: tx
    });

    // 2. Insert Invoice Item Lines
    for (const l of invoiceLines) {
      await orgDb.query(`
        INSERT INTO invoice_item_lines (
          id, invoice_id, item_id, description, quantity, 
          rate, gst_rate, taxable, cgst, sgst, igst, total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [
          uuid(), invoiceId, l.item_id, l.description, l.quantity, 
          l.rate, l.gst_rate, l.taxable, l.cgst, l.sgst, l.igst, l.total
        ],
        transaction: tx
      });
    }

    // 3. Mark Sales Order as Dispatched
    if (challan.sales_order_id) {
      await orgDb.query(`
        UPDATE sales_orders SET status = 'dispatched' WHERE id = ?
      `, { replacements: [challan.sales_order_id], transaction: tx });
    }

    await tx.commit();

    await orgDb.query(`
      INSERT INTO notifications (id, severity, title, description, source, is_read)
      VALUES (?, 'info', ?, ?, 'automation', 0)
    `, {
      replacements: [
        uuid(),
        `Auto Tax Invoice: ${invoiceNumber}`,
        `Tax Invoice #${invoiceNumber} for ₹${grandTotal} auto-drafted from Delivery Challan #${challan.challan_number || challanId}.`
      ]
    });

    return {
      triggered: true,
      invoice_id: invoiceId,
      invoice_number: invoiceNumber,
      grand_total: grandTotal,
      is_interstate: isInterstate
    };
  } catch (err) {
    await tx.rollback();
    console.error(`[AUTO INVOICE ERROR] Challan ${challanId}:`, err.message);
    throw err;
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
