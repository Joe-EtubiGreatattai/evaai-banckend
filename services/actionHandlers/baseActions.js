// baseActions.js (replace file)
const taskActions = require('./taskActions');
const invoiceActions = require('./invoiceActions');
const eventActions = require('./eventActions');
const chatActions = require('./chatActions');

const validateParams = (requiredFields, providedParams) => {
  const missingFields = requiredFields.filter(field => !providedParams[field]);
  return missingFields.length > 0 ? missingFields : null;
};

exports.handleActionRequest = async (userId, action, params) => {
  try {
    switch (action.type || action.action) {
      // Task
      case 'create_task':
      case 'update_task':
      case 'complete_task':
      case 'uncomplete_task':
      case 'reopen_task':
      case 'fetch_tasks':
        return await taskActions.handleTaskAction(userId, action, params);

      // Invoice
      case 'create_invoice':
      case 'update_invoice':
      case 'mark_invoice_paid':
      case 'pay_invoice':
      case 'send_invoice':
      case 'resend_invoice':
      case 'fetch_invoices':
        return await invoiceActions.handleInvoiceAction(userId, action, params);

      // Event
      case 'create_event':
      case 'update_event':
      case 'cancel_event':
      case 'delete_event':
      case 'fetch_events':
        return await eventActions.handleEventAction(userId, action, params);

      // Free text / explicit chat
      case 'chat':
      case 'nlu':
      case 'free_text':
        return await chatActions.handleChatAction(userId, action, params);

      // Fallback: default to chat if model/user didn’t specify a known action
      default: {
        const prompt =
          params?.prompt ??
          params?.text ??
          action?.text ??
          (typeof params === 'string' ? params : '') ??
          '';
        return await chatActions.handleChatAction(userId, { type: 'chat' }, { prompt });
      }
    }
  } catch (error) {
    console.error('Action handling error:', error);
    return { success: false, error: error.message };
  }
};
