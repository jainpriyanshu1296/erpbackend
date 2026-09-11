module.exports = { generate: async invoice => ({ status: 'pending', invoice_id: invoice }) , cancel: async invoice => ({ status: 'cancelled', invoice_id: invoice }) };
