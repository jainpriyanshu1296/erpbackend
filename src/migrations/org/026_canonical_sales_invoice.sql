-- Canonical sales-order and invoice-line migration. Legacy structures remain.
-- Conditional directives are evaluated through information_schema by run.js.
-- CREATE TEMPORARY TABLE does not implicitly commit and assertions therefore
-- precede every persistent ALTER/CREATE statement.
CREATE TEMPORARY TABLE canonical_sales_assertion (id INT PRIMARY KEY);
INSERT INTO canonical_sales_assertion VALUES (1);

-- @if-columns sales_order_items so_id order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM sales_order_items WHERE so_id IS NOT NULL AND order_id IS NOT NULL AND so_id<>order_id LIMIT 1;
-- @if-columns delivery_challans so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM delivery_challans WHERE so_id IS NOT NULL AND sales_order_id IS NOT NULL AND so_id<>sales_order_id LIMIT 1;
-- @if-columns invoices so_id order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoices WHERE so_id IS NOT NULL AND order_id IS NOT NULL AND so_id<>order_id LIMIT 1;
-- @if-columns invoices so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoices WHERE so_id IS NOT NULL AND sales_order_id IS NOT NULL AND so_id<>sales_order_id LIMIT 1;
-- @if-columns invoices order_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoices WHERE order_id IS NOT NULL AND sales_order_id IS NOT NULL AND order_id<>sales_order_id LIMIT 1;
-- @if-columns work_orders so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM work_orders WHERE so_id IS NOT NULL AND sales_order_id IS NOT NULL AND so_id<>sales_order_id LIMIT 1;
-- @if-columns production_orders so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM production_orders WHERE so_id IS NOT NULL AND sales_order_id IS NOT NULL AND so_id<>sales_order_id LIMIT 1;
-- @if-columns sales_returns so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM sales_returns WHERE so_id IS NOT NULL AND sales_order_id IS NOT NULL AND so_id<>sales_order_id LIMIT 1;
-- @if-columns invoices so_id sales_order_id order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoices WHERE COALESCE(so_id,sales_order_id,order_id) IS NOT NULL GROUP BY COALESCE(so_id,sales_order_id,order_id) HAVING COUNT(*)>1 LIMIT 1;

-- @if-columns sales_order_items so_id order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM sales_order_items i LEFT JOIN sales_orders so ON so.id=COALESCE(i.so_id,i.order_id) WHERE so.id IS NULL LIMIT 1;
-- @if-columns invoices so_id sales_order_id order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoices i LEFT JOIN sales_orders so ON so.id=COALESCE(i.so_id,i.sales_order_id,i.order_id) WHERE COALESCE(i.so_id,i.sales_order_id,i.order_id) IS NOT NULL AND (so.id IS NULL OR NOT(i.customer_id<=>so.customer_id)) LIMIT 1;
-- @if-columns delivery_challans so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM delivery_challans d LEFT JOIN sales_orders so ON so.id=COALESCE(d.so_id,d.sales_order_id) WHERE COALESCE(d.so_id,d.sales_order_id) IS NOT NULL AND (so.id IS NULL OR NOT(d.customer_id<=>so.customer_id)) LIMIT 1;
-- @if-columns work_orders so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM work_orders w LEFT JOIN sales_orders so ON so.id=COALESCE(w.so_id,w.sales_order_id) WHERE COALESCE(w.so_id,w.sales_order_id) IS NOT NULL AND so.id IS NULL LIMIT 1;
-- @if-columns production_orders so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM production_orders p LEFT JOIN sales_orders so ON so.id=COALESCE(p.so_id,p.sales_order_id) WHERE COALESCE(p.so_id,p.sales_order_id) IS NOT NULL AND so.id IS NULL LIMIT 1;
-- @if-columns sales_returns so_id sales_order_id
INSERT INTO canonical_sales_assertion SELECT 1 FROM sales_returns r LEFT JOIN sales_orders so ON so.id=COALESCE(r.so_id,r.sales_order_id) WHERE COALESCE(r.so_id,r.sales_order_id) IS NOT NULL AND (so.id IS NULL OR NOT(r.customer_id<=>so.customer_id)) LIMIT 1;

INSERT INTO canonical_sales_assertion SELECT 1 FROM invoice_items ii LEFT JOIN invoices i ON i.id=ii.invoice_id WHERE i.id IS NULL LIMIT 1;
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoice_item_lines il LEFT JOIN invoices i ON i.id=il.invoice_id WHERE i.id IS NULL LIMIT 1;
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoice_items ii JOIN invoice_item_lines il ON il.id=ii.id WHERE NOT (ii.invoice_id<=>il.invoice_id AND ii.item_id<=>il.item_id AND ii.description<=>il.description AND ii.quantity<=>il.quantity AND ii.rate<=>il.rate AND ii.discount_percent<=>il.discount_percent AND ii.gst_rate<=>il.gst_rate AND ii.taxable<=>il.taxable AND ii.cgst<=>il.cgst AND ii.sgst<=>il.sgst AND ii.igst<=>il.igst AND ii.total<=>il.total) LIMIT 1;
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoice_items ii WHERE EXISTS (SELECT 1 FROM invoice_item_lines il WHERE il.invoice_id=ii.invoice_id) AND NOT EXISTS (SELECT 1 FROM invoice_item_lines il WHERE il.id=ii.id) LIMIT 1;
INSERT INTO canonical_sales_assertion SELECT 1 FROM invoice_item_lines il WHERE EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=il.invoice_id) AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.id=il.id) LIMIT 1;

ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(7,2) DEFAULT 0;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(7,2) DEFAULT 0;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS delivered_qty DECIMAL(14,3) DEFAULT 0;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS creation_key VARCHAR(150) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS creation_hash CHAR(64) NULL;

-- @if-column sales_order_items order_id
ALTER TABLE sales_order_items MODIFY COLUMN order_id VARCHAR(36) NULL;
-- @if-column invoices order_id
ALTER TABLE invoices MODIFY COLUMN order_id VARCHAR(36) NULL;
-- @if-column sales_order_items order_id
UPDATE sales_order_items SET so_id=order_id WHERE so_id IS NULL AND order_id IS NOT NULL;
-- @if-column delivery_challans sales_order_id
UPDATE delivery_challans SET so_id=sales_order_id WHERE so_id IS NULL AND sales_order_id IS NOT NULL;
-- @if-column invoices sales_order_id
UPDATE invoices SET so_id=sales_order_id WHERE so_id IS NULL AND sales_order_id IS NOT NULL;
-- @if-column invoices order_id
UPDATE invoices SET so_id=order_id WHERE so_id IS NULL AND order_id IS NOT NULL;
-- @if-column work_orders sales_order_id
UPDATE work_orders SET so_id=sales_order_id WHERE so_id IS NULL AND sales_order_id IS NOT NULL;
-- @if-column production_orders sales_order_id
UPDATE production_orders SET so_id=sales_order_id WHERE so_id IS NULL AND sales_order_id IS NOT NULL;
-- @if-column sales_returns sales_order_id
UPDATE sales_returns SET so_id=sales_order_id WHERE so_id IS NULL AND sales_order_id IS NOT NULL;
UPDATE invoices SET creation_key=CONCAT('order:',so_id) WHERE creation_key IS NULL AND so_id IS NOT NULL;

INSERT INTO invoice_item_lines (id,invoice_id,item_id,description,quantity,rate,discount_percent,gst_rate,taxable,cgst,sgst,igst,total)
SELECT ii.id,ii.invoice_id,ii.item_id,ii.description,ii.quantity,ii.rate,ii.discount_percent,ii.gst_rate,ii.taxable,ii.cgst,ii.sgst,ii.igst,ii.total FROM invoice_items ii LEFT JOIN invoice_item_lines il ON il.id=ii.id WHERE il.id IS NULL;

CREATE UNIQUE INDEX uq_invoice_creation_key ON invoices(creation_key);
CREATE UNIQUE INDEX uq_invoice_sales_order ON invoices(so_id);
CREATE INDEX idx_sales_order_items_so_canonical ON sales_order_items(so_id);
CREATE INDEX idx_delivery_challans_so_canonical ON delivery_challans(so_id);
