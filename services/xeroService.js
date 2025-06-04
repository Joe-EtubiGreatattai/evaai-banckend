const xero = require('./xeroClient');
const AppError = require('../utils/appError');

let tenantId = null;

/**
 * Initializes Xero connection by setting the tenant ID
 * @returns {Promise<void>}
 */
const initializeXero = async () => {
  try {
    await xero.updateTenants();
    tenantId = xero.tenants[0].tenantId;
    console.log('✅ Xero tenant initialized:', tenantId);
  } catch (err) {
    console.error('❌ Error initializing Xero tenant:', err);
    throw new AppError('Failed to initialize Xero connection', 500);
  }
};

/**
 * Creates an invoice in Xero
 * @param {Object} invoiceData - Invoice data
 * @param {string} invoiceData.contactName - Contact name
 * @param {string} invoiceData.description - Invoice description
 * @param {number} invoiceData.quantity - Item quantity
 * @param {number} invoiceData.unitAmount - Item unit amount
 * @param {string} invoiceData.accountCode - Account code
 * @returns {Promise<Object>} - Created invoice
 */
const createXeroInvoice = async ({ contactName, description, quantity, unitAmount, accountCode }) => {
  try {
    if (!tenantId) {
      await initializeXero();
    }

    const result = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [{
        type: 'ACCREC',
        contact: { name: contactName },
        lineItems: [{
          description,
          quantity,
          unitAmount,
          accountCode
        }],
        date: new Date().toISOString(),
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'AUTHORISED'
      }]
    });

    return result.body.invoices[0];
  } catch (err) {
    console.error('❌ Error creating Xero invoice:', err.response?.data || err.message);
    throw new AppError('Failed to create Xero invoice', 500);
  }
};

/**
 * Gets all invoices from Xero
 * @returns {Promise<Array>} - Array of invoices
 */
const getXeroInvoices = async () => {
  try {
    if (!tenantId) {
      await initializeXero();
    }

    const result = await xero.accountingApi.getInvoices(tenantId);
    return result.body.invoices;
  } catch (err) {
    console.error('❌ Error fetching Xero invoices:', err.response?.data || err.message);
    throw new AppError('Failed to fetch Xero invoices', 500);
  }
};

module.exports = {
  initializeXero,
  createXeroInvoice,
  getXeroInvoices
};