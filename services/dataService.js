const { format, addDays, startOfDay, endOfDay, isAfter, isBefore, differenceInDays } = require('date-fns');
const User = require('../models/User');
const Task = require('../models/Task');
const Invoice = require('../models/Invoice');
const Event = require('../models/Event');

// Get user context data
exports.getUserContextData = async (userId) => {
  const currentDate = new Date();
  const oneWeekFromNow = addDays(currentDate, 7);

  const [user, tasks, invoices, events] = await Promise.all([
    User.findById(userId).select('+tradeType +fullName +email'),
    Task.find({ user: userId })
      .sort({ dueDate: 1, createdAt: -1 })
      .limit(20),
    Invoice.find({ user: userId })
      .sort({ dueDate: 1, createdAt: -1 })
      .limit(20),
    Event.find({ 
      user: userId,
      $or: [
        { 
          startTime: { 
            $gte: startOfDay(currentDate),
            $lte: endOfDay(oneWeekFromNow)
          }
        },
        { startTime: { $exists: false } },
        { startTime: null }
      ]
    }).sort({ startTime: 1 }).limit(20)
  ]);

  return {
    user,
    tasks,
    invoices: {
      all: invoices,
      pending: invoices.filter(i => i.status === 'Pending'),
      overdue: invoices.filter(i => i.status === 'Overdue'),
      paid: invoices.filter(i => i.status === 'Paid')
    },
    events
  };
};

// Format data for prompt
exports.formatDataForPrompt = (data) => {
  const now = new Date();
  
  const formatTask = (task) => {
    try {
      const dueDate = task.dueDate ? new Date(task.dueDate) : null;
      const isValidDueDate = dueDate && !isNaN(dueDate.getTime());
      
      return {
        id: task._id.toString(),
        title: task.title,
        status: task.completed ? '✅ Completed' : '🔄 Pending',
        dueDate: isValidDueDate ? format(dueDate, 'MMM dd, yyyy') : 'No due date',
        dueTime: isValidDueDate ? format(dueDate, 'h:mm a') : '',
        overdue: !task.completed && isValidDueDate && isBefore(dueDate, now) 
          ? ` (${differenceInDays(now, dueDate)} days overdue)` 
          : '',
        priority: task.priority || 'Medium',
        description: task.description || ''
      };
    } catch (error) {
      console.error('Error formatting task:', error);
      return {
        id: task._id.toString(),
        title: task.title,
        status: task.completed ? '✅ Completed' : '🔄 Pending',
        dueDate: 'Invalid date',
        dueTime: '',
        overdue: '',
        priority: task.priority || 'Medium',
        description: task.description || ''
      };
    }
  };

  const formatInvoice = (invoice) => {
    try {
      const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
      const isValidDueDate = dueDate && !isNaN(dueDate.getTime());
      
      return {
        id: invoice._id.toString(),
        client: invoice.clientName,
        amount: invoice.amount.toFixed(2),
        dueDate: isValidDueDate ? format(dueDate, 'MMM dd, yyyy') : 'No due date',
        status: invoice.status,
        overdue: invoice.status === 'Pending' && isValidDueDate && isBefore(dueDate, now)
      };
    } catch (error) {
      console.error('Error formatting invoice:', error);
      return {
        id: invoice._id.toString(),
        client: invoice.clientName,
        amount: invoice.amount.toFixed(2),
        dueDate: 'Invalid date',
        status: invoice.status,
        overdue: false
      };
    }
  };

  const formatEvent = (event) => {
    try {
      const start = event.startTime ? new Date(event.startTime) : null;
      const end = event.endTime ? new Date(event.endTime) : null;
      
      const isValidStart = start && !isNaN(start.getTime());
      const isValidEnd = end && !isNaN(end.getTime());
      
      return {
        id: event._id.toString(),
        title: event.title,
        date: isValidStart ? format(start, 'MMM dd, yyyy') : 'No date specified',
        startTime: isValidStart ? format(start, 'h:mm a') : 'No start time',
        endTime: isValidEnd ? format(end, 'h:mm a') : 'No end time',
        location: event.location || 'Not specified',
        upcoming: isValidStart ? isAfter(start, now) : false
      };
    } catch (error) {
      console.error('Error formatting event:', error);
      return {
        id: event._id.toString(),
        title: event.title,
        date: 'Invalid date',
        startTime: 'Invalid time',
        endTime: 'Invalid time',
        location: event.location || 'Not specified',
        upcoming: false
      };
    }
  };

  return {
    metadata: {
      currentDate: format(now, 'MMMM dd, yyyy'),
      currentTime: format(now, 'h:mm a'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    user: {
      name: data.user.fullName,
      trade: data.user.tradeType,
      email: data.user.email
    },
    tasks: {
      all: data.tasks.map(formatTask),
      completed: data.tasks.filter(t => t.completed).map(formatTask),
      pending: data.tasks.filter(t => !t.completed).map(formatTask),
      overdue: data.tasks.filter(t => 
        !t.completed && t.dueDate && isBefore(new Date(t.dueDate), now)
      ).map(formatTask),
      recent: data.tasks.slice(0, 5).map(formatTask)
    },
    invoices: {
      all: data.invoices.all.map(formatInvoice),
      pending: data.invoices.pending.map(formatInvoice),
      overdue: data.invoices.overdue.map(formatInvoice),
      paid: data.invoices.paid.map(formatInvoice)
    },
    events: {
      all: data.events.map(formatEvent),
      upcoming: data.events.filter(e => 
        e.startTime && isAfter(new Date(e.startTime), now)
      ).map(formatEvent),
      today: data.events.filter(e => 
        e.startTime && format(new Date(e.startTime), 'yyyy-MM-dd') === format(now, 'yyyy-MM-dd')
      ).map(formatEvent),
      recent: data.events.slice(0, 5).map(formatEvent)
    }
  };
};