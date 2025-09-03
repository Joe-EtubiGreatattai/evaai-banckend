const { XeroClient } = require('xero-node');
const dotenv = require('dotenv');
dotenv.config();

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.transactions',
    'accounting.contacts',
    'accounting.settings',
    'accounting.reports.read',
    'accounting.journals.read'
  ]
});

let tenantId = null;
let isAuthenticated = false;

class XeroController {
  // Connect user to Xero
  static async connect(req, res) {
    try {
      const consentUrl = await xero.buildConsentUrl();
      console.log(`Redirecting to Xero consent URL: ${consentUrl}`);
      res.redirect(consentUrl);
    } catch (error) {
      console.error('Error building consent URL:', error);
      res.status(500).json({ error: 'Failed to connect to Xero' });
    }
  }

  // OAuth callback
  static async callback(req, res) {
    try {
      const tokenSet = await xero.apiCallback(req.url);
      await xero.updateTenants();
      tenantId = xero.tenants[0].tenantId;
      isAuthenticated = true;
      
      console.log('Xero connected successfully. Tenant ID:', tenantId);
      res.send('✅ Xero connected successfully!');
    } catch (error) {
      console.error('Error in Xero callback:', error);
      isAuthenticated = false;
      res.status(500).send('Error connecting to Xero');
    }
  }

  // Create invoice
  static async createInvoice(req, res) {
    try {
      const { contactName, description, quantity, unitAmount, accountCode } = req.body;

      if (!tenantId || !isAuthenticated) {
        return res.status(400).json({ error: 'No tenant selected. Please connect to Xero first.' });
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

      res.json(result.body.invoices[0]);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'Error creating invoice' });
    }
  }

  // Get all invoices
  static async getInvoices(req, res) {
    try {
      if (!tenantId || !isAuthenticated) {
        return res.status(400).json({ error: 'No tenant selected. Please connect to Xero first.' });
      }

      const result = await xero.accountingApi.getInvoices(tenantId);
      res.json(result.body.invoices);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'Error fetching invoices' });
    }
  }

  // Get current tenant ID
  static getTenantId() {
    return tenantId;
  }

  // Get authenticated Xero client
  static getXeroClient() {
    return isAuthenticated ? xero : null;
  }

  // Check if authenticated
  static isAuthenticated() {
    return isAuthenticated && tenantId !== null;
  }
}

// Export both the class and helper functions
module.exports = XeroController;
module.exports.getTenantId = () => tenantId;
module.exports.getXeroClient = () => isAuthenticated ? xero : null;
module.exports.isAuthenticated = () => isAuthenticated && tenantId !== null;