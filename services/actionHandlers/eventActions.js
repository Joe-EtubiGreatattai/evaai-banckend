// eventActions.js
const mongoose = require('mongoose');
const Event = require('../../models/Event');
const { addDays, addHours, parseISO, isValid } = require('date-fns');

// Helper function to find event by ID or title
const findEvent = async (userId, identifier) => {
    console.log('[findEvent] userId:', userId, 'identifier:', identifier);
    if (!identifier) return null;
    
    if (mongoose.Types.ObjectId.isValid(identifier)) {
        console.log('[findEvent] Searching by ObjectId');
        return await Event.findOne({ _id: identifier, user: userId });
    } else {
        // Search by title (case insensitive, partial match)
        console.log('[findEvent] Searching by title');
        return await Event.findOne({ 
            title: { $regex: new RegExp(identifier, 'i') },
            user: userId 
        });
    }
};

// Helper to parse date input (ISO string or natural language)
const parseDateTime = (input, defaultDate = new Date()) => {
    if (!input) return null;
    
    // If input is already a Date object
    if (input instanceof Date) return input;
    
    // Try ISO format first
    const isoDate = new Date(input);
    if (!isNaN(isoDate.getTime())) return isoDate;
    
    // Try parsing as natural language (this would need a proper NLP library in production)
    // For now, we'll just add hours to the default date as a simple example
    if (typeof input === 'string' && input.includes('pm')) {
        const hours = parseInt(input) + 12;
        return new Date(defaultDate.setHours(hours, 0, 0, 0));
    }
    if (typeof input === 'string' && input.includes('am')) {
        const hours = parseInt(input);
        return new Date(defaultDate.setHours(hours, 0, 0, 0));
    }
    
    // Fallback to current date + 1 hour
    return addHours(new Date(), 1);
};

exports.handleEventAction = async (userId, action, params) => {
    console.log('[handleEventAction] userId:', userId, 'action:', action, 'params:', params);

    const requiredFields = {
        'create_event': ['title', 'startTime'],
        'update_event': ['eventId'],
        'cancel_event': ['eventId'],
        'delete_event': ['eventId']
    };
    
    const missingFields = validateParams(requiredFields[action.type || action.action] || [], params);
    if (missingFields?.length > 0) {
        console.log('[handleEventAction] Missing fields:', missingFields);
        return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields.join(', ')}`
        };
    }
    
    let result = null;
    
    switch (action.type || action.action) {
        case 'create_event':
            console.log('[handleEventAction] Creating event with params:', params);
            const startTime = parseDateTime(params.startTime);
            if (!isValid(startTime)) {
                throw new Error('Invalid start time format');
            }

            let endTime;
            if (params.endTime) {
                endTime = parseDateTime(params.endTime, startTime);
                if (!isValid(endTime)) {
                    throw new Error('Invalid end time format');
                }
                if (endTime <= startTime) {
                    throw new Error('End time must be after start time');
                }
            }

            result = await Event.create({
                title: params.title,
                description: params.description || '',
                startTime,
                ...(params.endTime && { endTime }), // Only include endTime if provided
                location: params.location || '',
                user: userId
            });
            console.log('[handleEventAction] Event created:', result);
            break;
        
        case 'update_event':
            console.log('[handleEventAction] Updating event with params:', params);
            const event = await findEvent(userId, params.eventId);
            console.log('[handleEventAction] Event found for update:', event);
            
            if (!event) {
                console.error('[handleEventAction] Event not found or no permission');
                throw new Error(`Event not found or you don't have permission to update it`);
            }
            
            const updateFields = {};
            
            if (params.title) updateFields.title = params.title;
            if (params.description !== undefined) updateFields.description = params.description;
            if (params.startTime) {
                updateFields.startTime = parseDateTime(params.startTime);
                if (!isValid(updateFields.startTime)) {
                    throw new Error('Invalid start time format');
                }
            }
            if (params.endTime) {
                updateFields.endTime = parseDateTime(params.endTime, updateFields.startTime || event.startTime);
                if (!isValid(updateFields.endTime)) {
                    throw new Error('Invalid end time format');
                }
            } else if (params.endTime === null) {
                // Allow explicitly setting endTime to null
                updateFields.endTime = null;
            }
            if (params.location !== undefined) updateFields.location = params.location;
            
            console.log('[handleEventAction] Update fields:', updateFields);
            result = await Event.findOneAndUpdate(
                { _id: event._id },
                updateFields,
                { new: true, runValidators: true }
            );
            console.log('[handleEventAction] Event updated:', result);
            break;

        case 'cancel_event':
            console.log('[handleEventAction] Cancelling event with params:', params);
            const eventToCancel = await findEvent(userId, params.eventId);
            console.log('[handleEventAction] Event found for cancel:', eventToCancel);
            
            if (!eventToCancel) {
                console.error('[handleEventAction] Event not found or no permission');
                throw new Error(`Event not found or you don't have permission to update it`);
            }
            
            result = await Event.findOneAndUpdate(
                { _id: eventToCancel._id },
                { cancelled: true },
                { new: true }
            );
            console.log('[handleEventAction] Event cancelled:', result);
            break;
            
        case 'delete_event':
            console.log('[handleEventAction] Deleting event with params:', params);
            const eventToDelete = await findEvent(userId, params.eventId);
            console.log('[handleEventAction] Event found for deletion:', eventToDelete);
            
            if (!eventToDelete) {
                console.error('[handleEventAction] Event not found or no permission');
                throw new Error(`Event not found or you don't have permission to delete it`);
            }
            
            result = await Event.deleteOne({ _id: eventToDelete._id });
            console.log('[handleEventAction] Event deleted:', result);
            
            // Return the deleted event data for reference
            result = {
                deletedEvent: eventToDelete,
                deleteResult: result
            };
            break;
            
        default:
            console.warn('[handleEventAction] Unknown action:', action.type || action.action);
    }
    
    console.log('[handleEventAction] Returning result:', result);
    return {
        success: true,
        data: result
    };
};

function validateParams(requiredFields, providedParams) {
    const missingFields = requiredFields.filter(field => !providedParams[field]);
    if (missingFields.length > 0) {
        console.log('[validateParams] Missing fields:', missingFields);
    }
    return missingFields.length > 0 ? missingFields : null;
}