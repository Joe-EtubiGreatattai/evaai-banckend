const XeroController = require('../../controllers/xeroController');

const XeroService = {
  /**
   * Builds and returns the Xero consent URL
   * @returns {Promise<string>} The consent URL
   */
  getConsentUrl: async () => {
    try {
      // Use the controller's client to build consent URL
      const xeroClient = XeroController.getXeroClient();
      if (!xeroClient) {
        throw new Error('Xero client not available');
      }
      
      const consentUrl = await xeroClient.buildConsentUrl();
      return consentUrl;
    } catch (error) {
      console.error('Error building consent URL:', error);
      throw new Error('Failed to build consent URL');
    }
  },

  /**
   * Creates an invoice in Xero
   * @param {Object} invoiceData Invoice data
   * @param {string} invoiceData.contactName Contact name
   * @param {Array} invoiceData.lineItems Array of line items
   * @param {string} invoiceData.date Invoice date (ISO string)
   * @param {string} invoiceData.dueDate Due date (ISO string)
   * @param {string} invoiceData.reference Invoice reference
   * @param {string} invoiceData.status Invoice status
   * @returns {Promise<Object>} Created invoice
   */
  createInvoice: async ({ contactName, lineItems, date, dueDate, reference, status = 'AUTHORISED' }) => {
    try {
      // Get the authenticated Xero client and tenant ID from controller
      const xeroClient = XeroController.getXeroClient();
      const tenantId = XeroController.getTenantId();

      if (!xeroClient || !tenantId) {
        throw new Error('No authenticated Xero connection. Please connect to Xero first.');
      }

      console.log('[XeroService.createInvoice] Creating invoice with:', {
        contactName,
        lineItems,
        date,
        dueDate,
        reference,
        status
      });

      const result = await xeroClient.accountingApi.createInvoices(tenantId, {
        invoices: [{
          type: 'ACCREC',
          contact: { name: contactName },
          lineItems: lineItems.map(item => ({
            description: item.description || 'Invoice item',
            quantity: item.quantity || 1,
            unitAmount: item.unitAmount || item.amount || 0,
            accountCode: item.accountCode || '200',
            ...(item.taxAmount && { taxAmount: item.taxAmount }),
            ...(item.lineAmount && { lineAmount: item.lineAmount })
          })),
          date: date || new Date().toISOString(),
          dueDate: dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          status: status,
          ...(reference && { reference: reference })
        }]
      });

      console.log('[XeroService.createInvoice] Invoice created successfully:', result.body.invoices[0]);
      return {
        invoiceID: result.body.invoices[0].invoiceID,
        invoiceNumber: result.body.invoices[0].invoiceNumber,
        reference: result.body.invoices[0].reference,
        status: result.body.invoices[0].status,
        total: result.body.invoices[0].total,
        amountDue: result.body.invoices[0].amountDue
      };
    } catch (error) {
      console.error('[XeroService.createInvoice] Error creating invoice:', {
        message: error.message || 'Unknown error',
        name: error.name,
        code: error.code,
        status: error.status,
        stack: error.stack,
        response: error.response?.data || error.response,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });
      
      // Provide more specific error messages based on common Xero API issues
      let errorMessage = 'Error creating invoice';
      
      if (error.response?.status === 401) {
        errorMessage = 'Xero authentication expired. Please reconnect to Xero.';
      } else if (error.response?.status === 403) {
        errorMessage = 'Insufficient permissions to create invoice in Xero.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid invoice data sent to Xero.';
      } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        errorMessage = 'Unable to connect to Xero API. Please check internet connection.';
      } else if (error.message) {
        errorMessage = `Error creating invoice: ${error.message}`;
      }
      
      throw new Error(errorMessage);
    }
  },

  /**
   * Updates an existing invoice in Xero
   * @param {Object} updateData Update data
   * @param {string} updateData.invoiceID The Xero invoice ID
   * @param {string} updateData.contactName Contact name
   * @param {Array} updateData.lineItems Array of line items
   * @param {string} updateData.reference Invoice reference
   * @returns {Promise<Object>} Updated invoice
   */
  updateInvoice: async ({ invoiceID, contactName, lineItems, reference }) => {
    try {
      const xeroClient = XeroController.getXeroClient();
      const tenantId = XeroController.getTenantId();

      if (!xeroClient || !tenantId) {
        throw new Error('No authenticated Xero connection. Please connect to Xero first.');
      }

      console.log('[XeroService.updateInvoice] Updating invoice:', {
        invoiceID,
        contactName,
        lineItems,
        reference
      });

      const result = await xeroClient.accountingApi.updateInvoice(tenantId, invoiceID, {
        invoices: [{
          invoiceID: invoiceID,
          contact: { name: contactName },
          lineItems: lineItems.map(item => ({
            description: item.description || 'Invoice item',
            quantity: item.quantity || 1,
            unitAmount: item.unitAmount || item.amount || 0,
            accountCode: item.accountCode || '200',
            ...(item.taxAmount && { taxAmount: item.taxAmount }),
            ...(item.lineAmount && { lineAmount: item.lineAmount })
          })),
          ...(reference && { reference: reference })
        }]
      });

      console.log('[XeroService.updateInvoice] Invoice updated successfully:', result.body.invoices[0]);
      return {
        invoiceID: result.body.invoices[0].invoiceID,
        invoiceNumber: result.body.invoices[0].invoiceNumber,
        reference: result.body.invoices[0].reference,
        status: result.body.invoices[0].status,
        total: result.body.invoices[0].total,
        amountDue: result.body.invoices[0].amountDue
      };
    } catch (error) {
      console.error('[XeroService.updateInvoice] Error updating invoice:', {
        message: error.message || 'Unknown error',
        name: error.name,
        code: error.code,
        status: error.status,
        stack: error.stack,
        response: error.response?.data || error.response,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });
      
      let errorMessage = 'Error updating invoice';
      
      if (error.response?.status === 401) {
        errorMessage = 'Xero authentication expired. Please reconnect to Xero.';
      } else if (error.response?.status === 403) {
        errorMessage = 'Insufficient permissions to update invoice in Xero.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid invoice data sent to Xero.';
      } else if (error.response?.status === 404) {
        errorMessage = 'Invoice not found in Xero.';
      } else if (error.message) {
        errorMessage = `Error updating invoice: ${error.message}`;
      }
      
      throw new Error(errorMessage);
    }
  },

  /**
   * Marks an invoice as paid in Xero
   * @param {Object} paymentData Payment data
   * @param {string} paymentData.invoiceID The Xero invoice ID
   * @param {number} paymentData.amountPaid Amount paid
   * @param {string} paymentData.paymentDate Payment date (ISO string)
   * @returns {Promise<Object>} Payment result
   */
  markInvoiceAsPaid: async ({ invoiceID, amountPaid, paymentDate }) => {
    try {
      const xeroClient = XeroController.getXeroClient();
      const tenantId = XeroController.getTenantId();

      if (!xeroClient || !tenantId) {
        throw new Error('No authenticated Xero connection. Please connect to Xero first.');
      }

      console.log('[XeroService.markInvoiceAsPaid] Marking invoice as paid:', {
        invoiceID,
        amountPaid,
        paymentDate
      });

      // Create a payment record in Xero
      const result = await xeroClient.accountingApi.createPayments(tenantId, {
        payments: [{
          invoice: { invoiceID: invoiceID },
          account: { code: '090' }, // Bank account code - adjust as needed
          amount: amountPaid,
          date: paymentDate || new Date().toISOString(),
          reference: `Payment for invoice ${invoiceID}`
        }]
      });

      console.log('[XeroService.markInvoiceAsPaid] Payment created successfully:', result.body.payments[0]);
      return {
        paymentID: result.body.payments[0].paymentID,
        status: 'PAID',
        amount: result.body.payments[0].amount,
        date: result.body.payments[0].date
      };
    } catch (error) {
      console.error('[XeroService.markInvoiceAsPaid] Error marking invoice as paid:', {
        message: error.message || 'Unknown error',
        name: error.name,
        code: error.code,
        status: error.status,
        stack: error.stack,
        response: error.response?.data || error.response,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });
      
      let errorMessage = 'Error marking invoice as paid';
      
      if (error.response?.status === 401) {
        errorMessage = 'Xero authentication expired. Please reconnect to Xero.';
      } else if (error.response?.status === 403) {
        errorMessage = 'Insufficient permissions to create payment in Xero.';
      } else if (error.response?.status === 400) {
        errorMessage = 'Invalid payment data sent to Xero.';
      } else if (error.response?.status === 404) {
        errorMessage = 'Invoice not found in Xero.';
      } else if (error.message) {
        errorMessage = `Error marking invoice as paid: ${error.message}`;
      }
      
      throw new Error(errorMessage);
    }
  },

  /**
   * Gets all invoices from Xero
   * @returns {Promise<Array>} Array of invoices
   */
  getInvoices: async () => {
    try {
      const xeroClient = XeroController.getXeroClient();
      const tenantId = XeroController.getTenantId();

      if (!xeroClient || !tenantId) {
        throw new Error('No authenticated Xero connection. Please connect to Xero first.');
      }

      const result = await xeroClient.accountingApi.getInvoices(tenantId);
      return result.body.invoices;
    } catch (error) {
      console.error('[XeroService.getInvoices] Error fetching invoices:', {
        message: error.message || 'Unknown error',
        name: error.name,
        code: error.code,
        status: error.status,
        stack: error.stack,
        response: error.response?.data || error.response,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });
      
      let errorMessage = 'Error fetching invoices';
      
      if (error.response?.status === 401) {
        errorMessage = 'Xero authentication expired. Please reconnect to Xero.';
      } else if (error.response?.status === 403) {
        errorMessage = 'Insufficient permissions to fetch invoices from Xero.';
      } else if (error.message) {
        errorMessage = `Error fetching invoices: ${error.message}`;
      }
      
      throw new Error(errorMessage);
    }
  },

  /**
   * Gets the current tenant ID from controller
   * @returns {string|null} The current tenant ID or null if not set
   */
  getTenantId: () => {
    return XeroController.getTenantId();
  },

  /**
   * Checks if Xero is properly authenticated
   * @returns {boolean} True if authenticated, false otherwise
   */
  isAuthenticated: () => {
    return XeroController.isAuthenticated();
  }
};

module.exports = XeroService;