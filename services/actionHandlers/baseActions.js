const taskActions = require('./taskActions');
const invoiceActions = require('./invoiceActions');
const eventActions = require('./eventActions');

const validateParams = (requiredFields, providedParams) => {
  const missingFields = requiredFields.filter(field => !providedParams[field]);
  return missingFields.length > 0 ? missingFields : null;
};

exports.handleActionRequest = async (userId, action, params) => {
  try {
    let result = null;
    let missingFields = [];
    
    switch (action.type || action.action) {
      // Task actions
      case 'create_task':
      case 'update_task':
      case 'complete_task':
      case 'uncomplete_task':
      case 'reopen_task':
      case 'fetch_tasks': // Added fetch_tasks action
        return await taskActions.handleTaskAction(userId, action, params);
      
      // Invoice actions
      case 'create_invoice':
      case 'update_invoice':
      case 'mark_invoice_paid':
      case 'pay_invoice':
      case 'send_invoice': // Added send_invoice action
      case 'resend_invoice': // Added resend_invoice action
      case 'fetch_invoices': // Added fetch_invoices action
        return await invoiceActions.handleInvoiceAction(userId, action, params);
      
      // Event actions
      case 'create_event':
      case 'update_event':
      case 'cancel_event':
      case 'delete_event':
      case 'fetch_events': // Added fetch_events action
        return await eventActions.handleEventAction(userId, action, params);
      
      default:
        throw new Error(`Unknown action type: ${action.type || action.action}`);
    }
  } catch (error) {
    console.error('Action handling error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};