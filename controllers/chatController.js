const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { getUserContextData } = require('../services/dataService');
const { generateAIResponse } = require('../services/openaiService');
const { handleActionRequest } = require('../services/actionHandlers/baseActions');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

exports.sendMessage = catchAsync(async (req, res, next) => {
  const { text } = req.body;
  console.log('🟡 [sendMessage] Function called');
  console.log('🔹 Request user ID:', req.user?.id);
  console.log('🔹 Incoming text:', text);

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.warn('❗ [Validation] Invalid or empty message text:', text);
    return next(new AppError('Please provide valid message text', 400));
  }

  // Get or create conversation
  let conversation;
  try {
    conversation = await Conversation.findOne({ user: req.user.id });
    if (!conversation) {
      console.log('ℹ️ [Conversation] No conversation found. Creating a new one for user:', req.user.id);
      conversation = await Conversation.create({ user: req.user.id });
      console.log('✅ [Conversation] New conversation created:', conversation._id);
    } else {
      console.log('✅ [Conversation] Existing conversation found:', conversation._id);
    }
  } catch (err) {
    console.error('❌ [Conversation] Error retrieving or creating conversation:', err);
    return next(new AppError('Error handling conversation', 500));
  }

  // Save user message
  let userMessage;
  try {
    userMessage = await Message.create({
      text: text.trim(),
      sender: 'user',
      conversation: conversation._id,
      user: req.user.id
    });
    console.log('✅ [Message] User message saved:', userMessage._id);
  } catch (err) {
    console.error('❌ [Message] Failed to save user message:', err);
    return next(new AppError('Failed to save user message', 500));
  }

  // Get context data and conversation history
  let conversationHistory, userContext;
  try {
    [conversationHistory, userContext] = await Promise.all([
      Message.find({ conversation: conversation._id })
        .sort({ createdAt: 1 })
        .select('text sender createdAt'),
      getUserContextData(req.user.id)
    ]);
    console.log(`✅ [History] Retrieved ${conversationHistory.length} messages`);
    console.log('✅ [Context] User context retrieved:', userContext);
  } catch (err) {
    console.error('❌ [Data Fetch] Error fetching history or context:', err);
    return next(new AppError('Failed to retrieve conversation history or context', 500));
  }

  // Generate AI response
  let finalResponse, actionResult;
  try {
    ({ finalResponse, actionResult } = await generateAIResponse(
      req.user.id,
      userContext,
      conversationHistory,
      text.trim()
    ));
    console.log('✅ [AI] Response generated:', finalResponse);
    if (actionResult) console.log('ℹ️ [AI] Action result returned:', actionResult);
  } catch (err) {
    console.error('❌ [AI] Error generating AI response:', err);
    return next(new AppError('AI failed to generate a response', 500));
  }

  // Save assistant message
  let assistantMessage;
  try {
    assistantMessage = await Message.create({
      text: finalResponse,
      sender: 'assistant',
      conversation: conversation._id,
      user: req.user.id
    });
    console.log('✅ [Message] Assistant message saved:', assistantMessage._id);
  } catch (err) {
    console.error('❌ [Message] Failed to save assistant message:', err);
    return next(new AppError('Failed to save assistant message', 500));
  }

  // Final response to client
  console.log('🟢 [sendMessage] Response ready to be sent to client');
  res.status(201).json({
    status: 'success',
    data: {
      messages: [userMessage, assistantMessage],
      actionResult
    }
  });
});


// Get conversation history
exports.getConversation = catchAsync(async (req, res, next) => {
  let conversation = await Conversation.findOne({ user: req.user.id });
  
  if (!conversation) {
    conversation = await Conversation.create({ user: req.user.id });
  }
  
  const messages = await Message.find({ conversation: conversation._id })
    .sort({ createdAt: 1 })
    .select('text sender createdAt');
  
  res.status(200).json({
    status: 'success',
    data: {
      conversation: {
        id: conversation._id,
        messages
      }
    }
  });
});

// Clear conversation
exports.clearConversation = catchAsync(async (req, res, next) => {
  const conversation = await Conversation.findOne({ user: req.user.id });
  
  if (!conversation) {
    return next(new AppError('No conversation found', 404));
  }
  
  await Message.deleteMany({ conversation: conversation._id });
  
  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Get suggested prompts
exports.getSuggestions = catchAsync(async (req, res, next) => {
  const suggestions = [
    { text: "Mark 'Fix kitchen plumbing' as complete", type: "task", action: "complete_task" },
    { text: "Reopen 'Client meeting prep' task", type: "task", action: "uncomplete_task" },
    { text: "Create a new task for tomorrow", type: "task", action: "create_task" },
    { text: "Show me my overdue invoices", type: "invoice", action: "list_invoices" },
    { text: "What's on my schedule for tomorrow?", type: "event", action: "list_events" },
    { text: "Create an invoice for my recent job", type: "invoice", action: "create_invoice" },
    { text: "Schedule a client meeting next Tuesday", type: "event", action: "create_event" }
  ];
  
  res.status(200).json({
    status: 'success',
    data: {
      suggestions
    }
  });
});

// Transcribe audio
exports.transcribeAudio = catchAsync(async (req, res, next) => {
  try {
    console.log('Incoming request to transcribeAudio');
    console.log('Request file:', req.file);
    console.log('Request body:', req.body);

    let audioBuffer;
    let fileName = 'recording';
    let mimeType = 'audio/mpeg';

    if (req.file?.buffer) {
      console.log('Audio received via file upload');
      audioBuffer = req.file.buffer;
      fileName = req.file.originalname || fileName;
      mimeType = req.file.mimetype || mimeType;
    } else if (req.body.audio && req.body.isBase64) {
      console.log('Audio received via base64 string');
      audioBuffer = Buffer.from(req.body.audio, 'base64');
      fileName = req.body.filename || `${fileName}.${req.body.format || 'mp3'}`;
      mimeType = `audio/${req.body.format || 'mpeg'}`;
    } else {
      console.warn('No valid audio data received');
      return next(new AppError('No valid audio data received', 400));
    }

    if (!audioBuffer?.length) {
      console.warn('Empty audio buffer');
      return next(new AppError('Empty audio data received', 400));
    }

    const maxSize = 25 * 1024 * 1024;
    console.log(`Audio buffer size: ${audioBuffer.length} bytes`);

    if (audioBuffer.length > maxSize) {
      console.warn(`Audio file too large: ${audioBuffer.length} bytes`);
      return next(new AppError(`Audio file too large (max ${maxSize / 1024 / 1024}MB)`, 400));
    }

    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);
    console.log(`Writing audio buffer to temp path: ${tempPath}`);
    fs.writeFileSync(tempPath, audioBuffer);

    console.log('Sending audio to OpenAI Whisper model for transcription');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'en',
      response_format: 'json'
    });

    console.log('Transcription result:', transcription);

    fs.unlinkSync(tempPath);
    console.log(`Temporary file deleted: ${tempPath}`);

    res.status(200).json({
      status: 'success',
      data: { text: transcription.text }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    return next(new AppError(`Transcription failed: ${error.message}`, 500));
  }
});

