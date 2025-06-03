// controllers/eveDroppingController.js
const OpenAI = require('openai');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Task = require('../models/Task');
const Event = require('../models/Event');
const Invoice = require('../models/Invoice');
const { parseDateTime, isValid } = require('date-fns');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

exports.uploadMeetingAudio = (req, res, next) => {
    if (!req.file) {
        return next(new AppError('Please upload an audio file', 400));
    }
    next();
};

exports.processMeeting = catchAsync(async (req, res, next) => {
    let tempPath = null;
    
    try {
        console.log('--- processMeeting called ---');
        console.log('Request file:', req.file);
        
        // Validate OpenAI API key
        if (!process.env.OPENAI_API_KEY) {
            return next(new AppError('OpenAI API key not configured', 500));
        }
        
        let audioBuffer;
        let fileName = 'recording';
        let mimeType = 'audio/mpeg';

        if (req.file?.buffer) {
            console.log('Audio received via file upload');
            audioBuffer = req.file.buffer;
            fileName = req.file.originalname || fileName;
            mimeType = req.file.mimetype || mimeType;
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

        // Create temp file with better error handling
        tempPath = path.join(os.tmpdir(), `meeting-${Date.now()}-${Math.random().toString(36).substring(7)}.${getFileExtension(fileName, mimeType)}`);
        console.log(`Writing audio buffer to temp path: ${tempPath}`);
        
        try {
            fs.writeFileSync(tempPath, audioBuffer);
        } catch (fsError) {
            console.error('Failed to write temp file:', fsError);
            return next(new AppError('Failed to process audio file', 500));
        }

        console.log('Transcribing audio...');
        let transcription;
        try {
            transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: 'whisper-1',
                language: 'en',
                response_format: 'json'
            });
        } catch (transcriptionError) {
            console.error('Transcription failed:', transcriptionError);
            return next(new AppError(`Transcription failed: ${transcriptionError.message}`, 500));
        }

        if (!transcription?.text) {
            console.warn('No transcription text received');
            return next(new AppError('Failed to transcribe audio', 500));
        }

        console.log('Transcription result:', transcription.text);
        
        // Generate all meeting details from the transcription
        console.log('Generating meeting details...');
        const meetingDetails = await generateMeetingDetails(transcription.text);
        
        res.status(200).json({
            status: 'success',
            data: meetingDetails
        });

    } catch (error) {
        console.error('Processing error:', error);
        return next(new AppError(`Meeting processing failed: ${error.message}`, 500));
    } finally {
        // Always clean up temp file
        if (tempPath && fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
                console.log(`Temporary file deleted: ${tempPath}`);
            } catch (cleanupError) {
                console.error('Failed to delete temp file:', cleanupError);
            }
        }
    }
});

// Helper function to get file extension
function getFileExtension(fileName, mimeType) {
    if (fileName && fileName.includes('.')) {
        return fileName.split('.').pop().toLowerCase();
    }
    
    // Fallback based on mime type
    const mimeToExt = {
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/wav': 'wav',
        'audio/wave': 'wav',
        'audio/x-wav': 'wav',
        'audio/mp4': 'm4a',
        'audio/m4a': 'm4a',
        'audio/webm': 'webm',
        'audio/ogg': 'ogg'
    };
    
    return mimeToExt[mimeType] || 'mp3';
}

// Helper function to generate all meeting details
async function generateMeetingDetails(transcript) {
    if (!transcript || transcript.trim().length === 0) {
        throw new Error('Empty transcript provided');
    }

    try {
        // First get the summary with better error handling
        const summaryResponse = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `You are a helpful meeting assistant that analyzes meeting transcripts and extracts:
                    1. A concise summary
                    2. Action points (array of strings)
                    3. Tasks with details (array of objects with title, description, dueDate, priority)
                    4. Events with details (array of objects with title, description, location, startTime, endTime)
                    5. Invoices with details (array of objects with clientName, amount, description, dueDate)
                    
                    For dates and times:
                    - Use current date/time as reference point (today is ${new Date().toISOString()})
                    - For events: startTime must be before endTime
                    - For tasks: dueDate should be in the future
                    - For invoices: dueDate should be at least 7 days in the future
                    
                    Always respond with a valid JSON object containing these fields, even if some arrays are empty.
                    Ensure dates are in ISO 8601 format.`
                },
                {
                    role: 'user',
                    content: `Analyze this meeting transcript and extract the required details in JSON format:
                    
                    ${transcript.substring(0, 4000)}` // Limit transcript length to avoid token limits
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 2000
        });

        if (!summaryResponse?.choices?.[0]?.message?.content) {
            throw new Error('No response from OpenAI');
        }

        let meetingDetails;
        try {
            meetingDetails = JSON.parse(summaryResponse.choices[0].message.content);
        } catch (parseError) {
            console.error('Error parsing meeting details:', parseError);
            console.error('Raw response:', summaryResponse.choices[0].message.content);
            throw new Error('Failed to parse meeting details from AI response');
        }

        // Helper function to parse and validate dates
        const parseAndValidateDate = (dateString, defaultOffset, isEvent = false) => {
            try {
                if (!dateString) {
                    const defaultDate = new Date();
                    defaultDate.setDate(defaultDate.getDate() + defaultOffset);
                    return defaultDate.toISOString();
                }
                
                const parsedDate = new Date(dateString);
                if (isNaN(parsedDate.getTime())) {
                    throw new Error('Invalid date');
                }
                
                // For events, ensure they're not in the past
                if (isEvent && parsedDate < new Date()) {
                    const adjustedDate = new Date();
                    adjustedDate.setHours(parsedDate.getHours(), parsedDate.getMinutes());
                    if (adjustedDate < new Date()) {
                        adjustedDate.setDate(adjustedDate.getDate() + 1);
                    }
                    return adjustedDate.toISOString();
                }
                
                return parsedDate.toISOString();
            } catch (error) {
                const defaultDate = new Date();
                defaultDate.setDate(defaultDate.getDate() + defaultOffset);
                return defaultDate.toISOString();
            }
        };

        // Ensure all required fields exist and have proper structure with better validation
        const result = {
            summary: typeof meetingDetails.summary === 'string' ? 
                meetingDetails.summary : 'No summary generated',
            actionPoints: Array.isArray(meetingDetails.actionPoints) ? 
                meetingDetails.actionPoints.filter(point => typeof point === 'string') : [],
            tasks: Array.isArray(meetingDetails.tasks) ? 
                meetingDetails.tasks.map(task => {
                    const dueDate = parseAndValidateDate(task.dueDate, 7);
                    return {
                        id: generateId(),
                        title: typeof task.title === 'string' ? task.title : 'Untitled Task',
                        description: typeof task.description === 'string' ? task.description : '',
                        dueDate,
                        priority: ['Low', 'Medium', 'High'].includes(task.priority) ? 
                            task.priority : 'Medium'
                    };
                }).filter(task => task.title !== 'Untitled Task' || task.description) : [],
            events: Array.isArray(meetingDetails.events) ? 
                meetingDetails.events.map(event => {
                    const startTime = parseAndValidateDate(event.startTime, 1, true);
                    let endTime;
                    
                    if (event.endTime) {
                        endTime = parseAndValidateDate(event.endTime, 1, true);
                        // Ensure end time is after start time
                        if (new Date(endTime) <= new Date(startTime)) {
                            const defaultEnd = new Date(startTime);
                            defaultEnd.setHours(defaultEnd.getHours() + 1);
                            endTime = defaultEnd.toISOString();
                        }
                    } else {
                        const defaultEnd = new Date(startTime);
                        defaultEnd.setHours(defaultEnd.getHours() + 1);
                        endTime = defaultEnd.toISOString();
                    }
                    
                    return {
                        id: generateId(),
                        title: typeof event.title === 'string' ? event.title : 'Untitled Event',
                        description: typeof event.description === 'string' ? event.description : '',
                        location: typeof event.location === 'string' ? event.location : '',
                        startTime,
                        endTime
                    };
                }).filter(event => event.title !== 'Untitled Event' || event.description) : [],
            invoices: Array.isArray(meetingDetails.invoices) ? 
                meetingDetails.invoices.map(invoice => {
                    const dueDate = parseAndValidateDate(invoice.dueDate, 30);
                    return {
                        id: generateId(),
                        clientName: typeof invoice.clientName === 'string' ? 
                            invoice.clientName : 'Unknown Client',
                        amount: typeof invoice.amount === 'number' && invoice.amount >= 0 ? 
                            invoice.amount : 0,
                        description: typeof invoice.description === 'string' ? invoice.description : '',
                        dueDate
                    };
                }).filter(invoice => invoice.clientName !== 'Unknown Client' || invoice.amount > 0) : [],
            message: 'Meeting processed successfully'
        };

        console.log('Generated meeting details:', result);
        return result;
        
    } catch (error) {
        console.error('Error in generateMeetingDetails:', error);
        
        // Return a fallback response instead of throwing
        return {
            summary: 'Failed to generate detailed summary. Please try again.',
            actionPoints: [],
            tasks: [],
            events: [],
            invoices: [],
            message: `Processing completed with errors: ${error.message}`
        };
    }
}

// Helper function to validate ISO date strings
function isValidDate(dateString) {
    if (typeof dateString !== 'string') return false;
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime()) && dateString.includes('T');
}

// Helper function to generate simple IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Save all meeting items to their respective collections
exports.saveAllItems = catchAsync(async (req, res, next) => {
    try {
        const { tasks, events, invoices } = req.body;
        
        // Validate user exists
        if (!req.user?.id) {
            return next(new AppError('User authentication required', 401));
        }
        
        const userId = req.user.id;
        
        console.log('--- saveAllItems called ---');
        console.log('User ID:', userId);
        
        // Validate input data
        if ((!Array.isArray(tasks) || tasks.length === 0) && 
            (!Array.isArray(events) || events.length === 0) && 
            (!Array.isArray(invoices) || invoices.length === 0)) {
            return next(new AppError('At least one non-empty array of items (tasks, events, or invoices) is required', 400));
        }
        
        // Process tasks
        let savedTasks = [];
        if (Array.isArray(tasks) && tasks.length > 0) {
            const taskPromises = tasks.map(task => 
                Task.create({
                    title: task.title,
                    description: task.description,
                    dueDate: new Date(task.dueDate),
                    priority: task.priority,
                    user: userId
                })
            );
            savedTasks = await Promise.all(taskPromises);
        }
        
        // Process events
        let savedEvents = [];
        if (Array.isArray(events) && events.length > 0) {
            const eventPromises = events.map(event => 
                Event.create({
                    title: event.title,
                    description: event.description,
                    location: event.location,
                    startTime: new Date(event.startTime),
                    endTime: event.endTime ? new Date(event.endTime) : undefined,
                    user: userId
                })
            );
            savedEvents = await Promise.all(eventPromises);
        }
        
        // Process invoices
        let savedInvoices = [];
        if (Array.isArray(invoices) && invoices.length > 0) {
            const invoicePromises = invoices.map(invoice => 
                Invoice.create({
                    clientName: invoice.clientName,
                    amount: invoice.amount,
                    description: invoice.description,
                    dueDate: new Date(invoice.dueDate),
                    user: userId
                })
            );
            savedInvoices = await Promise.all(invoicePromises);
        }
        
        res.status(200).json({
            status: 'success',
            data: {
                savedTasks: savedTasks,
                savedEvents: savedEvents,
                savedInvoices: savedInvoices,
                message: 'All items saved successfully'
            }
        });
    } catch (error) {
        console.error('Save items error:', error);
        return next(new AppError('Failed to save items', 500));
    }
});

// Save a single task
exports.saveTask = catchAsync(async (req, res, next) => {
    const taskData = req.body;
    
    if (!taskData || typeof taskData !== 'object') {
        return next(new AppError('Valid task data is required', 400));
    }
    
    // Validate user exists
    if (!req.user?.id) {
        return next(new AppError('User authentication required', 401));
    }
    
    const task = await Task.create({
        title: taskData.title,
        description: taskData.description || '',
        dueDate: taskData.dueDate ? new Date(taskData.dueDate) : new Date(),
        priority: taskData.priority || 'Medium',
        user: req.user.id
    });
    
    res.status(201).json({
        status: 'success',
        data: {
            task,
            message: 'Task saved successfully'
        }
    });
});

// Save a single event
exports.saveEvent = catchAsync(async (req, res, next) => {
    const eventData = req.body;
    
    if (!eventData || typeof eventData !== 'object') {
        return next(new AppError('Valid event data is required', 400));
    }
    
    // Validate user exists
    if (!req.user?.id) {
        return next(new AppError('User authentication required', 401));
    }
    
    const startTime = new Date(eventData.startTime);
    if (!isValid(startTime)) {
        return next(new AppError('Invalid start time', 400));
    }
    
    let endTime;
    if (eventData.endTime) {
        endTime = new Date(eventData.endTime);
        if (!isValid(endTime)) {
            return next(new AppError('Invalid end time', 400));
        }
        if (endTime <= startTime) {
            return next(new AppError('End time must be after start time', 400));
        }
    }
    
    const event = await Event.create({
        title: eventData.title,
        description: eventData.description || '',
        location: eventData.location || '',
        startTime,
        endTime,
        user: req.user.id
    });
    
    res.status(201).json({
        status: 'success',
        data: {
            event,
            message: 'Event saved successfully'
        }
    });
});

// Save a single invoice
exports.saveInvoice = catchAsync(async (req, res, next) => {
    const invoiceData = req.body;
    
    if (!invoiceData || typeof invoiceData !== 'object') {
        return next(new AppError('Valid invoice data is required', 400));
    }
    
    // Validate user exists
    if (!req.user?.id) {
        return next(new AppError('User authentication required', 401));
    }
    
    const invoice = await Invoice.create({
        clientName: invoiceData.clientName,
        amount: invoiceData.amount || 0,
        description: invoiceData.description || '',
        dueDate: new Date(invoiceData.dueDate),
        user: req.user.id
    });
    
    res.status(201).json({
        status: 'success',
        data: {
            invoice,
            message: 'Invoice saved successfully'
        }
    });
});