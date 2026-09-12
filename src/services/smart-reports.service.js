/**
 * Smart Natural Language Query Reports Service
 * Pure SQL parameterized templates answering core factory questions.
 * Zero external AI API required.
 */

const SMART_QUERIES = [
  {
    id: 'top_customers_revenue',
    title: 'Top Revenue Generating Customers',
    question: 'Pichle mahine sabse zyada revenue kaunse customer se?',
    category: 'Sales',
    chartType: 'bar',
    xAxisKey: 'customer_name',
    yAxisKey: 'total_revenue'
  },
  {
    id: 'items_below_reorder',
    title: 'Items Currently Below Reorder Level',
    question: 'Is hafte konsa item reorder level se neeche hai?',
    category: 'Inventory',
    chartType: 'bar',
    xAxisKey: 'item_name',
    yAxisKey: 'deficit_qty'
  },
  {
    id: 'vendor_rejection_ranking',
    title: 'Vendor QC Rejection Rate Ranking',
    question: 'Konsa vendor sabse zyada rejection deta hai?',
    category: 'Quality',
    chartType: 'bar',
    xAxisKey: 'vendor_name',
    yAxisKey: 'rejection_rate_percent'
  },
  {
    id: 'wo_average_delays',
    title: 'Work Order Turnaround & Shop Floor Delays',
    question: 'WO mein average delay kitna hai?',
    category: 'Production',
    chartType: 'bar',
    xAxisKey: 'product_name',
    yAxisKey: 'avg_delay_days'
  },
  {
    id: 'top_consumption_items',
    title: 'Top 10 Consumed Raw Materials',
    question: 'Top 10 items by consumption last quarter?',
    category: 'Inventory',
    chartType: 'bar',
    xAxisKey: 'item_name',
    yAxisKey: 'total_consumed_value'
  },
  {
    id: 'overdue_invoices_30_days',
    title: 'Invoices Overdue by More than 30 Days',
    question: 'Konse invoices 30 days se zyada overdue hain?',
    category: 'Finance',
    chartType: 'bar',
    xAxisKey: 'invoice_number',
    yAxisKey: 'balance_amount'
  },
  {
    id: 'machine_production_output',
    title: 'Machine-wise Production Output This Month',
    question: 'Machine-wise production this month?',
    category: 'Production',
    chartType: 'bar',
    xAxisKey: 'machine_name',
    yAxisKey: 'total_produced'
  },
  {
    id: 'hr_employee_absenteeism',
    title: 'Highest Employee Absenteeism Ranking',
    question: 'HR: Kaun zyada absent raha is mahine?',
    category: 'HR',
    chartType: 'bar',
    xAxisKey: 'employee_name',
    yAxisKey: 'absent_days'
  }
];

function getAvailableQueries() {
  return SMART_QUERIES;
}

async function executeSmartQuery(orgDb, queryId, params = {}) {
  switch (queryId) {
    case 'top_customers_revenue': {
      const days = Number(params.days || 30);
      const [rows] = await orgDb.query(`
        SELECT 
          c.id as customer_id,
          c.company_name as customer_name,
          c.customer_code,
          COUNT(i.id) as invoice_count,
          COALESCE(SUM(i.total_amount), 0) as total_revenue,
          COALESCE(SUM(i.balance_amount), 0) as outstanding_balance
        FROM customers c
        JOIN invoices i ON i.customer_id = c.id
        WHERE i.invoice_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY c.id, c.company_name, c.customer_code
        ORDER BY total_revenue DESC
        LIMIT 15
      `, { replacements: [days] });
      return {
        query_id: queryId,
        title: 'Top Revenue Generating Customers',
        rows,
        summary: `Top customer is ${rows[0]?.customer_name || 'N/A'} with ₹${rows[0]?.total_revenue || 0} revenue.`
      };
    }

    case 'items_below_reorder': {
      const [rows] = await orgDb.query(`
        SELECT 
          im.id as item_id,
          im.item_code,
          im.item_name,
          im.category,
          im.reorder_level,
          COALESCE(ss.current_stock, 0) as current_stock,
          ROUND(im.reorder_level - COALESCE(ss.current_stock, 0), 2) as deficit_qty,
          im.standard_cost,
          ROUND((im.reorder_level - COALESCE(ss.current_stock, 0)) * im.standard_cost, 2) as estimated_procurement_cost
        FROM item_master im
        LEFT JOIN (
          SELECT item_id, SUM(current_qty) as current_stock 
          FROM stock_summary 
          GROUP BY item_id
        ) ss ON ss.item_id = im.id
        WHERE im.is_active = 1 
          AND im.reorder_level > 0 
          AND COALESCE(ss.current_stock, 0) < im.reorder_level
        ORDER BY deficit_qty DESC
        LIMIT 50
      `);
      return {
        query_id: queryId,
        title: 'Items Currently Below Reorder Level',
        rows,
        summary: `${rows.length} item(s) are currently running below their designated safety reorder thresholds.`
      };
    }

    case 'vendor_rejection_ranking': {
      const [rows] = await orgDb.query(`
        SELECT 
          v.id as vendor_id,
          v.company_name as vendor_name,
          v.vendor_code,
          COUNT(qi.id) as inspections_count,
          COALESCE(SUM(qi.inspected_qty), 0) as total_inspected,
          COALESCE(SUM(qi.rejected_qty), 0) as total_rejected,
          CASE 
            WHEN SUM(qi.inspected_qty) > 0 
            THEN ROUND((SUM(qi.rejected_qty) / SUM(qi.inspected_qty)) * 100, 2)
            ELSE 0 
          END as rejection_rate_percent
        FROM vendors v
        JOIN grn g ON g.vendor_id = v.id
        JOIN qc_inspections qi ON qi.reference_id = g.id
        GROUP BY v.id, v.company_name, v.vendor_code
        HAVING total_rejected > 0
        ORDER BY rejection_rate_percent DESC
        LIMIT 20
      `);
      return {
        query_id: queryId,
        title: 'Vendor QC Rejection Rate Ranking',
        rows,
        summary: rows.length 
          ? `Highest rejection rate observed from ${rows[0].vendor_name} (${rows[0].rejection_rate_percent}%).`
          : 'No QC rejections recorded across vendors.'
      };
    }

    case 'wo_average_delays': {
      const [rows] = await orgDb.query(`
        SELECT 
          im.item_name as product_name,
          im.item_code,
          COUNT(wo.id) as total_work_orders,
          COALESCE(SUM(wo.planned_qty), 0) as total_planned_qty,
          COALESCE(SUM(wo.produced_qty), 0) as total_produced_qty,
          ROUND(AVG(GREATEST(0, DATEDIFF(COALESCE(wo.actual_end, NOW()), wo.created_at))), 1) as avg_turnaround_days,
          ROUND(AVG(GREATEST(0, DATEDIFF(COALESCE(wo.actual_end, NOW()), DATE_ADD(wo.created_at, INTERVAL 3 DAY)))), 1) as avg_delay_days
        FROM work_orders wo
        JOIN item_master im ON im.id = wo.finished_item_id
        GROUP BY im.id, im.item_name, im.item_code
        ORDER BY total_work_orders DESC
        LIMIT 20
      `);
      return {
        query_id: queryId,
        title: 'Work Order Turnaround & Shop Floor Delays',
        rows,
        summary: `Average manufacturing turnaround across products is ${rows[0]?.avg_turnaround_days || 0} days.`
      };
    }

    case 'top_consumption_items': {
      const [rows] = await orgDb.query(`
        SELECT 
          im.id as item_id,
          im.item_code,
          im.item_name,
          im.category,
          COALESCE(SUM(sl.qty_out), 0) as total_consumed_qty,
          ROUND(COALESCE(SUM(sl.amount), 0), 2) as total_consumed_value
        FROM stock_ledger sl
        JOIN item_master im ON im.id = sl.item_id
        WHERE sl.transaction_type IN ('production_issue', 'dispatch', 'sale')
          AND sl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        GROUP BY im.id, im.item_code, im.item_name, im.category
        ORDER BY total_consumed_value DESC
        LIMIT 10
      `);
      return {
        query_id: queryId,
        title: 'Top 10 Consumed Raw Materials',
        rows,
        summary: `Top consumed material is ${rows[0]?.item_name || 'N/A'} totaling ₹${rows[0]?.total_consumed_value || 0}.`
      };
    }

    case 'overdue_invoices_30_days': {
      const [rows] = await orgDb.query(`
        SELECT 
          i.id as invoice_id,
          i.invoice_number,
          c.company_name as customer_name,
          c.phone as customer_phone,
          i.invoice_date,
          i.total_amount,
          i.balance_amount,
          DATEDIFF(CURDATE(), i.invoice_date) as days_overdue
        FROM invoices i
        JOIN customers c ON c.id = i.customer_id
        WHERE i.status != 'paid' 
          AND i.balance_amount > 0 
          AND DATEDIFF(CURDATE(), i.invoice_date) > 30
        ORDER BY days_overdue DESC
        LIMIT 50
      `);
      const totalOverdue = rows.reduce((s, r) => s + Number(r.balance_amount), 0);
      return {
        query_id: queryId,
        title: 'Invoices Overdue by More than 30 Days',
        rows,
        summary: `${rows.length} overdue invoices totaling ₹${Math.round(totalOverdue * 100) / 100} in locked working capital.`
      };
    }

    case 'machine_production_output': {
      const [rows] = await orgDb.query(`
        SELECT 
          m.id as machine_id,
          m.machine_name,
          m.machine_code,
          COUNT(wro.id) as operations_count,
          COALESCE(SUM(wro.completed_qty), 0) as total_produced,
          COALESCE(SUM(wro.rejected_qty), 0) as total_rejected,
          CASE 
            WHEN SUM(wro.completed_qty + wro.rejected_qty) > 0 
            THEN ROUND((SUM(wro.completed_qty) / SUM(wro.completed_qty + wro.rejected_qty)) * 100, 1)
            ELSE 100 
          END as efficiency_percent
        FROM machines m
        LEFT JOIN wo_routing_operations wro ON wro.machine_id = m.id 
          AND wro.actual_end >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY m.id, m.machine_name, m.machine_code
        ORDER BY total_produced DESC
      `);
      return {
        query_id: queryId,
        title: 'Machine-wise Production Output This Month',
        rows,
        summary: `Top performing machine is ${rows[0]?.machine_name || 'N/A'} with ${rows[0]?.total_produced || 0} units produced.`
      };
    }

    case 'hr_employee_absenteeism': {
      const [rows] = await orgDb.query(`
        SELECT 
          e.id as employee_id,
          e.name as employee_name,
          e.employee_code,
          d.name as department_name,
          COUNT(a.id) as absent_days
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        JOIN attendance a ON a.employee_id = e.id
        WHERE a.status = 'absent'
          AND a.attendance_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY e.id, e.name, e.employee_code, d.name
        ORDER BY absent_days DESC
        LIMIT 20
      `);
      return {
        query_id: queryId,
        title: 'Highest Employee Absenteeism Ranking',
        rows,
        summary: rows.length
          ? `Highest absence: ${rows[0].employee_name} (${rows[0].absent_days} days absent this month).`
          : 'Zero unexcused absences recorded this month.'
      };
    }

    default:
      throw Object.assign(new Error(`Unknown smart query id: ${queryId}`), { status: 400 });
  }
}

module.exports = {
  getAvailableQueries,
  executeSmartQuery
};
