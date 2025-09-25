// baseActions.js
const taskActions = require('./taskActions');
const invoiceActions = require('./invoiceActions');
const eventActions = require('./eventActions');
const chatActions = require('./chatActions');

const User = require('../../models/User');
const Event = require('../../models/Event');
const Task = require('../../models/Task');

const validateParams = (requiredFields, providedParams) => {
  const missingFields = requiredFields.filter(field => !providedParams[field]);
  return missingFields.length > 0 ? missingFields : null;
};

exports.handleActionRequest = async (userId, action, params) => {
  try {
    const type = action.type || action.action;

    // Pre-hook: enrich invoice actions with phoneNumber and log full user + their events and tasks
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

          // Log user, events, and tasks in the SAME if-statement
          const [events, tasks] = await Promise.all([
            Event.find({ user: userDoc._id }).sort({ startTime: 1 }).lean(),
            Task.find({ user: userDoc._id }).sort({ createdAt: -1 }).lean()
          ]);

          // console.log('[invoice:user] full user document', userDoc, {
          //   eventCount: events.length,
          //   taskCount: tasks.length
          // });
          // console.log('[invoice:user:events]', events);
          // console.log('[invoice:user:tasks]', tasks);
        } else {
          console.warn('[invoice:user] no user found for userId', userId);
        }
      } catch (e) {
        console.error('[invoice:user] failed to load user and related docs:', e?.message || e);
      }
    }

    switch (type) {
      // Optional utility: fetch both via a single action
      case 'fetch_user_events_and_tasks': {
        try {
          const [events, tasks] = await Promise.all([
            Event.find({ user: userId }).sort({ startTime: 1 }).lean(),
            Task.find({ user: userId }).sort({ createdAt: -1 }).lean()
          ]);

          // console.log('[events:all] userId:', userId, 'count:', events.length);
          // console.log('[events:all] documents:', events);
          // console.log('[tasks:all] userId:', userId, 'count:', tasks.length);
          // console.log('[tasks:all] documents:', tasks);

          return {
            success: true,
            events,
            tasks,
            counts: { events: events.length, tasks: tasks.length }
          };
        } catch (e) {
          console.error('[fetch_user_events_and_tasks] failed:', e?.message || e);
          return { success: false, error: e?.message || String(e) };
        }
      }

      // Task
      case 'create_task':
      case 'update_task':
      case 'complete_task':
      case 'uncomplete_task':
      case 'reopen_task':
      case 'fetch_tasks': {
        const res = await taskActions.handleTaskAction(userId, action, params);
        try { console.log('[tasks:handler:result]', res); } catch (_) {}
        return res;
      }

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
      case 'fetch_events': {
        const res = await eventActions.handleEventAction(userId, action, params);
        try { console.log('[events:handler:result]', res); } catch (_) {}
        return res;
      }

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
