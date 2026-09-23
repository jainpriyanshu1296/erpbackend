const { v4: uuid } = require('uuid');
const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45);
const pick = (obj, keys) =>
  keys.reduce((out, key) => {
    if (obj[key] !== undefined) out[key] = obj[key];
    return out;
  }, {});
module.exports = { uuid, slugify, pick };
