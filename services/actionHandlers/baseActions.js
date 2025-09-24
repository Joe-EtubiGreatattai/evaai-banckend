// baseActions.js
const taskActions = require('./taskActions');
const invoiceActions = require('./invoiceActions');
const eventActions = require('./eventActions');
const chatActions = require('./chatActions');
const User = require('../../models/User');

const validateParams = (requiredFields, providedParams) => {
  const missingFields = requiredFields.filter(field => !providedParams[field]);
  return missingFields.length > 0 ? missingFields : null;
};

exports.handleActionRequest = async (userId, action, params) => {
  try {
    const type = action.type || action.action;

    // Pre-hook: enrich invoice actions with phoneNumber and log full user
    const isInvoiceAction = [
      'create_invoice',
      'update_invoice',
      'mark_invoice_paid',
      'pay_invoice',
      'send_invoice',
      'resend_invoice',
      'fetch_invoices'
    ].includes(type);

    if (isInvoiceAction) {
      params = params || {};
      try {
        const userDoc = await User.findById(userId).lean();
        if (userDoc) {
          if (!params.phoneNumber && userDoc.phoneNumber) {
            params.phoneNumber = userDoc.phoneNumber;
            console.log('[invoice:params] injecting phoneNumber from user record', params.phoneNumber);
          }
          console.log('[invoice:user] full user document', userDoc);
        } else {
          console.warn('[invoice:user] no user found for userId', userId);
        }
      } catch (e) {
        console.error('[invoice:user] failed to load user for phone enrichment:', e?.message || e);
      }
    }

    switch (type) {
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

      // Chat
      case 'chat':
      case 'nlu':
      case 'free_text':
        return await chatActions.handleChatAction(userId, action, params);

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
