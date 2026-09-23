const masterDb = require('../config/db');

const defaults = {
  brand: 'Daanoday ERP',
  headline: 'Manufacturing, connected.',
  introduction: 'Bring purchasing, inventory, production, quality and sales into one organization workspace.',
  features: ['Purchase and supplier management', 'Inventory and warehouse operations', 'Production planning and execution', 'Quality inspections and corrective actions', 'Sales and dispatch', 'Finance and reporting'],
  workflow: ['Procure materials', 'Receive and inspect', 'Plan and produce', 'Inspect finished goods', 'Dispatch and invoice'],
  benefits: ['Keep operational records together', 'Give teams role-based access', 'Follow stock movement across warehouses'],
  cta: 'Create your organization',
  contact_email: '',
  footer: 'Daanoday ERP · Manufacturing operations'
};

function validate(content) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_CMS_CONTENT' }); };
  if (!content || typeof content !== 'object' || Array.isArray(content)) invalid('Content must be an object');
  if (Object.keys(content).some(key => !(key in defaults))) invalid('Unknown content field');
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = content[key];
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 300)) invalid(`Invalid ${key}`);
      result[key] = value.map(entry => entry.trim());
    } else {
      if (typeof value !== 'string' || value.length > 2000 || (key !== 'contact_email' && !value.trim())) invalid(`Invalid ${key}`);
      result[key] = value.trim();
    }
  }
  if (result.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contact_email)) invalid('Invalid contact email');
  return result;
}
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

async function read(publishedOnly = false) {
  const [rows] = await masterDb.query('SELECT * FROM public_pages WHERE page_key=?', { replacements: ['landing'] });
  const row = rows[0];
  return {
    content: row ? decode(publishedOnly ? row.published_content : row.draft_content) || defaults : defaults,
    revision: publishedOnly ? undefined : Number(row?.revision || 0),
    published_at: row?.published_at || null
  };
}

async function save({ content, revision, publish }, actor) {
  const validated = validate(content);
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof publish !== 'boolean') throw Object.assign(new Error('revision and publish are required'), { status: 400 });
  return masterDb.transaction(async transaction => {
    await masterDb.query('INSERT IGNORE INTO public_pages(page_key,draft_content,revision) VALUES(?,?,0)', { replacements: ['landing', JSON.stringify(defaults)], transaction });
    const [rows] = await masterDb.query('SELECT revision FROM public_pages WHERE page_key=? FOR UPDATE', { replacements: ['landing'], transaction });
    if (Number(rows[0].revision) !== revision) throw Object.assign(new Error('Content changed. Reload before saving.'), { status: 409, code: 'CMS_REVISION_CONFLICT' });
    const json = JSON.stringify(validated);
    await masterDb.query(`UPDATE public_pages SET draft_content=?,revision=revision+1,updated_by=?${publish ? ',published_content=?,published_at=NOW()' : ''} WHERE page_key=?`, { replacements: [json, actor, ...(publish ? [json] : []), 'landing'], transaction });
    return { revision: revision + 1, published: publish };
  });
}

module.exports = { defaults, validate, read, save };
