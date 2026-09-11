const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
const required = (body, fields) => fields.filter(field => body[field] === undefined || body[field] === null || body[field] === '');
module.exports = { email, required };
