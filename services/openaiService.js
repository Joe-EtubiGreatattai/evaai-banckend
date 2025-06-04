// openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

exports.generateAIResponse = async (userId, userContext, conversationHistory, userMessage) => {
  // Format data for prompt
  const formattedData = formatDataForPrompt(userContext);
  
  // Enhanced system prompt with clear distinctions between tasks, events, and invoices
  const systemPrompt = `You are Eve, an AI assistant specialized for ${userContext.user.tradeType}s.
  
User Profile:
- Name: ${formattedData.user.name}
- Trade: ${formattedData.user.trade}
- Email: ${formattedData.user.email}

Current Date: ${formattedData.metadata.currentDate}
Current Time: ${formattedData.metadata.currentTime}
Timezone: ${formattedData.metadata.timezone}

ACTION GUIDELINES:

1. EVENT MANAGEMENT:
- Creation: "create event [title]", "schedule [event] on [date]", "add calendar event for [purpose]"
- Identification: Use exact titles in quotes or IDs (e.g., "Team Meeting" or event_123)
- Fields:
  - Title: Short descriptive name
  - Start Time: Required, in format "YYYY-MM-DD HH:MM" or natural language like "tomorrow at 2pm"
  - End Time: Optional, defaults nothing if not provided
  - Location: Optional physical or virtual location
- Modifications: "reschedule [event]", "change [event] time", "update event location"
- Fetching: "show my events", "what's on my calendar", "list upcoming events"

2. TASK MANAGEMENT:
- Creation: "create task [title]", "add task for [description]", "new task to [action]"
- Identification: Use exact titles in quotes or IDs (e.g., "Fix plumbing" or task_123)
- Status Changes:
  - Complete: "mark [task] as done", "finish [task]"
  - Reopen: "reopen [task]", "mark [task] as pending"
- Fetching: "show my tasks", "what do I have to do", "list all tasks"
  - Can filter by:
    - Status: "show my completed tasks"
    - Priority: "show high priority tasks"
    - Date: "tasks due this week"
    - Tags: "tasks tagged 'urgent'"
  - No task ID needed for fetching multiple tasks

3. INVOICE MANAGEMENT:
- Creation: "create invoice for [client]", "bill [client] [amount]", "new invoice"
- Sending Existing: "send invoice to [client]", "email the invoice", "send him/her the invoice"
- Identification: 
  - By ID: "inv_123"
  - By client: "John Smith" (most recent)
  - By amount: "$100" or "100" (most recent)
  - By date: "May 20" or "05/20" (most recent due date)
  - Combine criteria: "John's $100 invoice from May"
- Status Changes:
  - Pay: "mark invoice as paid", "record payment for [client]", "pay $100 to John"
  - Update: "update invoice for [client]", "change invoice amount"
- Fetching: "show my invoices", "list unpaid invoices", "what invoices are due"

IMPORTANT INVOICE SENDING RULES:
- If user says "send [him/her/them] the invoice" or "email the invoice" → Use send_invoice action for the most recent/relevant invoice
- If user provides a specific email address → Use that email
- If no email provided, try to extract from conversation history or use client's known email
- If creating AND sending an invoice → Use create_invoice with email parameter
- If just sending existing invoice → Use send_invoice with invoiceId and email

4. ACTION SELECTION RULES:
- When calendar/scheduling terms are used → Event action
- When money or billing is mentioned → Invoice action
- When work or to-do items are mentioned → Task action
- For "send invoice" commands → Check if invoice exists first, then use send_invoice
- For ambiguous cases, ask for clarification

CURRENT DATA:

Events (${formattedData.events?.all?.length || 0}):
${formattedData.events?.recent?.map(e => 
  `- ${e.title} (${e.startTime} to ${e.endTime}) [ID: ${e.id}]`
).join('\n') || 'No events found'}

Tasks (${formattedData.tasks.all.length}):
${formattedData.tasks.recent.map(t => 
  `- ${t.title} ${t.status} (Due: ${t.dueDate}${t.overdue}) [ID: ${t.id}]`
).join('\n') || 'No tasks found'}

Invoices (${formattedData.invoices.all.length}):
${formattedData.invoices.all.slice(0, 5).map(i => 
  `- ${i.client} ($${i.amount}) ${i.status} (Due: ${i.dueDate}) [ID: ${i.id}]`
).join('\n') || 'No invoices found'}

RESPONSE FORMAT (JSON):
{
  "action": "create_event|create_task|create_invoice|update_event|send_invoice|...|fetch_tasks|fetch_events|fetch_invoices",
  "params": {
    // For events:
    "eventId": "ID or 'Exact Title'",
    "title": "Event title",
    "startTime": "YYYY-MM-DD HH:MM or natural language",
    "endTime": "YYYY-MM-DD HH:MM or natural language",
    "location": "Optional location",
    
    // For tasks:
    "taskId": "ID or 'Exact Title'",
    "title": "Task title",
    "dueDate": "YYYY-MM-DD or 'tomorrow'",
    "status": "Completed|Pending|In Progress",
    "priority": "High|Medium|Low",
    "tags": ["tag1", "tag2"],
    
    // For invoices:
    "invoiceId": "ID or 'Client Name'",
    "clientName": "Client name",
    "amount": 100.00,
    "dueDate": "YYYY-MM-DD",
    "email": "recipient@email.com", // REQUIRED for sending invoices
    
    // Common:
    "description": "Optional details",
    
    // For fetch actions:
    "filter": {
      "status": "completed|pending|overdue",
      "priority": "high|medium|low",
      "dateRange": {
        "start": "YYYY-MM-DD",
        "end": "YYYY-MM-DD"
      },
      "tags": ["tag1", "tag2"]
    },
    "sort": {
      "field": "dueDate|createdAt|priority",
      "order": "asc|desc"
    }
  },
  "response": "Your natural language confirmation",
  "needsClarification": {
    "field": "eventId/taskId/invoiceId/clientName/email/etc",
    "question": "What should I use for [field]?",
    "options": ["Option 1", "Option 2"]
  }
}

CONTEXT ANALYSIS:
- Look for email addresses in conversation history
- Identify the most recent invoice when user says "send the invoice"
- Extract client names and associate with their known email addresses
- If sending an invoice but no email provided, ask for clarification`;

  // Prepare messages for OpenAI
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    })),
    { role: "user", content: userMessage }
  ];
  
  // Generate AI response with lower temperature for more deterministic behavior
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4-turbo",
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });
  
  let aiResponse = completion.choices[0].message.content;
  let parsedResponse;
  let finalResponse;
  let actionResult = null;
  
  try {
    parsedResponse = JSON.parse(aiResponse);
    
    // Handle clarification requests
    if (parsedResponse.needsClarification) {
      finalResponse = parsedResponse.response || 
        `I need more information: ${parsedResponse.needsClarification.question}`;
      
      if (parsedResponse.needsClarification.options) {
        finalResponse += `\n\nOptions:\n${parsedResponse.needsClarification.options
          .map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
      }
    } 
    // Handle actions with additional validation
    else if (parsedResponse.action && parsedResponse.action !== 'none') {
      // Enhanced validation for invoice sending
      if (parsedResponse.action === 'send_invoice') {
        if (!parsedResponse.params.email) {
          // Try to extract email from conversation history or user context
          const extractedEmail = extractEmailFromContext(conversationHistory, userContext);
          if (extractedEmail) {
            parsedResponse.params.email = extractedEmail;
          } else {
            throw new Error('Email address is required to send invoice. Please provide recipient email address.');
          }
        }
        
        if (!parsedResponse.params.invoiceId && !parsedResponse.params.clientName) {
          // Find the most recent invoice
          if (formattedData.invoices.all.length > 0) {
            const recentInvoice = formattedData.invoices.all[0];
            parsedResponse.params.invoiceId = recentInvoice.id;
          } else {
            throw new Error('No invoices found to send.');
          }
        }
      }
      
      // Skip validation for fetch actions
      if (!parsedResponse.action.includes('fetch')) {
        // Validate action type matches parameters
        if (parsedResponse.action.includes('event') && !parsedResponse.params.title && !parsedResponse.params.eventId) {
          throw new Error('Event actions require either title or eventId');
        }
        
        if (parsedResponse.action.includes('invoice') && !parsedResponse.params.clientName && !parsedResponse.params.invoiceId) {
          throw new Error('Invoice actions require either clientName or invoiceId');
        }
        
        if (parsedResponse.action.includes('task') && !parsedResponse.params.title && !parsedResponse.params.taskId) {
          throw new Error('Task actions require either title or taskId');
        }
      }
      
      actionResult = await handleActionRequest(
        userId,
        parsedResponse,
        parsedResponse.params
      );
      
      if (actionResult.success) {
        // Enhanced confirmation message with action-specific details
        if (parsedResponse.action.includes('event')) {
          finalResponse = parsedResponse.response || 
            `Event "${actionResult.data?.title}" scheduled for ${actionResult.data?.startTime}.`;
        } else if (parsedResponse.action === 'send_invoice') {
          finalResponse = parsedResponse.response || 
            `Invoice sent successfully to ${parsedResponse.params.email}${actionResult.data ? ` for ${actionResult.data.clientName}` : ''}.`;
        } else if (parsedResponse.action.includes('invoice')) {
          finalResponse = parsedResponse.response || 
            `Invoice processed successfully${actionResult.data ? ` for ${actionResult.data.clientName}` : ''}.`;
        } else if (parsedResponse.action.includes('task')) {
          finalResponse = parsedResponse.response || 
            `Task ${actionResult.data?.title ? `"${actionResult.data.title}"` : ''} processed successfully.`;
        } else if (parsedResponse.action.includes('fetch')) {
          // For fetch actions, use the AI's response or a default message
          finalResponse = parsedResponse.response || "Here are the results:";
        } else {
          finalResponse = parsedResponse.response || "Action completed successfully.";
        }
      } else {
        finalResponse = `I couldn't complete that action: ${actionResult.error}`;
      }
    } 
    // Regular response
    else {
      finalResponse = parsedResponse.response || aiResponse;
    }
  } catch (e) {
    console.error('Response processing error:', e);
    finalResponse = `I encountered an issue processing your request. Please try again.\n\nError: ${e.message}`;
  }
  
  return { finalResponse, actionResult };
};

// Helper function to extract email from context
function extractEmailFromContext(conversationHistory, userContext) {
  // Check user's email first
  if (userContext.user.email) {
    return userContext.user.email;
  }
  
  // Look for email patterns in conversation history
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const message = conversationHistory[i];
    const emailMatch = message.text.match(emailRegex);
    if (emailMatch) {
      return emailMatch[0];
    }
  }
  
  return null;
}