// services/eveService.js
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

// Eve's knowledge base
const eveResponses = {
  greetings: [
    "Hello there! How can I assist you today?",
    "Hi! What can I do for you?",
    "Greetings! How may I help you?"
  ],
  invoices: [
    "I can help you manage your invoices. Would you like to check your pending invoices or create a new one?",
    "Let me check your invoice status. You have 3 pending invoices totaling £1,200.",
    "Invoice management is one of my specialties. What would you like to know?"
  ],
  tasks: [
    "Let me help you with your tasks. You have 2 tasks due today. Would you like to see them?",
    "Task management is important. You have 1 overdue task and 3 upcoming this week.",
    "I can help organize your tasks. What would you like to focus on?"
  ],
  schedule: [
    "Your next appointment is an inspection at 3:00 PM today. Would you like me to remind you 30 minutes before?",
    "Looking at your calendar, you have a client meeting tomorrow at 10 AM.",
    "Your schedule looks clear for the rest of the day. Would you like to add something?"
  ],
  default: [
    "I understand you need assistance. Could you please provide more details so I can help you better?",
    "I'm not sure I understand. Could you rephrase that?",
    "Let me think about how to best help with that. Could you give me more context?"
  ]
};

// Generate Eve's response based on user message
exports.generateResponse = async (userId, userMessage) => {
  const lowerCaseMessage = userMessage.toLowerCase();
  
  let responseType = 'default';
  
  if (/hello|hi|hey/.test(lowerCaseMessage)) {
    responseType = 'greetings';
  } else if (/invoice|payment|bill/.test(lowerCaseMessage)) {
    responseType = 'invoices';
  } else if (/task|todo|reminder/.test(lowerCaseMessage)) {
    responseType = 'tasks';
  } else if (/schedule|calendar|appointment|meeting/.test(lowerCaseMessage)) {
    responseType = 'schedule';
  }
  
  // Get random response from the appropriate category
  const responses = eveResponses[responseType];
  const randomIndex = Math.floor(Math.random() * responses.length);
  
  return responses[randomIndex];
};

// Get contextual information about the user
exports.getUserContext = async (userId) => {
  const user = await User.findById(userId);
  
  // In a real implementation, you would fetch actual data from other services
  return {
    pendingInvoices: 3,
    overdueTasks: 1,
    nextAppointment: {
      title: 'Inspection',
      time: '3:00 PM',
      date: new Date().toISOString().split('T')[0]
    }
  };
};