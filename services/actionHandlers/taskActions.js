const mongoose = require('mongoose');
const Task = require('../../models/Task');
const { addDays, isAfter, isBefore, parseISO } = require('date-fns');

// Helper function to find task by title or ID
const findTask = async (userId, identifier) => {
    console.log('[findTask] userId:', userId, 'identifier:', identifier);
    if (!identifier) return null;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
        const task = await Task.findOne({ _id: identifier, user: userId });
        console.log('[findTask] Found by ID:', task);
        return task;
    } else {
        // Search by title (case insensitive, exact match)
        const task = await Task.findOne({
            title: { $regex: new RegExp(`^${identifier}$`, 'i') },
            user: userId
        });
        console.log('[findTask] Found by title:', task);
        return task;
    }
};

// Helper function to parse date input
const parseDateInput = (input, defaultDate = new Date()) => {
    console.log('[parseDateInput] input:', input, 'defaultDate:', defaultDate);
    if (!input) return null;

    if (input instanceof Date) return input;

    const isoDate = new Date(input);
    if (!isNaN(isoDate.getTime())) {
        console.log('[parseDateInput] Parsed as ISO date:', isoDate);
        return isoDate;
    }

    if (typeof input === 'string') {
        const lowerInput = input.toLowerCase().trim();
        if (lowerInput === 'today') return new Date();
        if (lowerInput === 'tomorrow') return addDays(new Date(), 1);
        if (lowerInput === 'yesterday') return addDays(new Date(), -1);
        if (lowerInput === 'next week') return addDays(new Date(), 7);
        if (lowerInput === 'next month') return addDays(new Date(), 30);
    }

    console.log('[parseDateInput] Fallback to defaultDate:', defaultDate);
    return defaultDate;
};

exports.handleTaskAction = async (userId, action, params) => {
    console.log('[handleTaskAction] userId:', userId, 'action:', action, 'params:', params);
    const now = new Date();
    const requiredFields = {
        'create_task': ['title'],
        'update_task': ['taskId'],
        'complete_task': ['taskId'],
        'uncomplete_task': ['taskId'],
        'reopen_task': ['taskId'],
        'fetch_tasks': []
    };

    const missingFields = validateParams(requiredFields[action.type || action.action] || [], params);
    if (missingFields?.length > 0) {
        console.log('[handleTaskAction] Missing fields:', missingFields);
        return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields.join(', ')}`
        };
    }

    let result = null;

    try {
        switch (action.type || action.action) {
            case 'create_task':
                let dueDate = parseDateInput(params.dueDate, addDays(now, 7));
                console.log('[create_task] dueDate:', dueDate);

                if (dueDate && isBefore(dueDate, now) && !params.allowPastDue) {
                    console.log('[create_task] Due date in the past:', dueDate);
                    return {
                        success: false,
                        error: 'Due date cannot be in the past'
                    };
                }

                result = await Task.create({
                    title: params.title,
                    description: params.description || '',
                    dueDate: dueDate,
                    priority: ['Low', 'Medium', 'High'].includes(params.priority)
                        ? params.priority
                        : 'Medium',
                    completed: false,
                    status: params.status || 'Not Started',
                    user: userId,
                    tags: params.tags || [],
                    ...(params.projectId && { project: params.projectId })
                });
                console.log('[create_task] Created task:', result);
                break;

            case 'update_task':
                const task = await findTask(userId, params.taskId);
                console.log('[update_task] Task to update:', task);

                if (!task) {
                    console.log('[update_task] Task not found');
                    throw new Error(`Task not found or you don't have permission to update it`);
                }

                const updateFields = {};

                if (params.title) updateFields.title = params.title;
                if (params.description !== undefined) updateFields.description = params.description;
                if (params.completed !== undefined) {
                    updateFields.completed = Boolean(params.completed);
                    updateFields.completedAt = params.completed ? new Date() : null;
                }
                if (params.dueDate) {
                    updateFields.dueDate = parseDateInput(params.dueDate);
                    if (isNaN(updateFields.dueDate.getTime())) {
                        console.log('[update_task] Invalid due date:', params.dueDate);
                        throw new Error('Invalid due date format');
                    }
                }
                if (params.priority) {
                    updateFields.priority = ['Low', 'Medium', 'High'].includes(params.priority)
                        ? params.priority
                        : 'Medium';
                }
                if (params.status) {
                    updateFields.status = params.status;
                }
                if (params.tags !== undefined) {
                    updateFields.tags = Array.isArray(params.tags) ? params.tags : [];
                }
                if (params.projectId !== undefined) {
                    updateFields.project = params.projectId || null;
                }
                console.log('[update_task] updateFields:', updateFields);

                result = await Task.findOneAndUpdate(
                    { _id: task._id },
                    updateFields,
                    { new: true, runValidators: true }
                );
                console.log('[update_task] Updated task:', result);
                break;

            case 'complete_task':
                const taskToComplete = await findTask(userId, params.taskId);
                console.log('[complete_task] Task to complete:', taskToComplete);

                if (!taskToComplete) {
                    console.log('[complete_task] Task not found');
                    throw new Error(`Task not found or you don't have permission to update it`);
                }

                result = await Task.findOneAndUpdate(
                    { _id: taskToComplete._id },
                    {
                        completed: true,
                        completedAt: new Date(),
                        status: 'Completed'
                    },
                    { new: true }
                );
                console.log('[complete_task] Completed task:', result);
                break;

            case 'uncomplete_task':
            case 'reopen_task':
                const taskToReopen = await findTask(userId, params.taskId);
                console.log('[reopen_task] Task to reopen:', taskToReopen);

                if (!taskToReopen) {
                    console.log('[reopen_task] Task not found');
                    throw new Error(`Task not found or you don't have permission to update it`);
                }

                result = await Task.findOneAndUpdate(
                    { _id: taskToReopen._id },
                    {
                        completed: false,
                        completedAt: null,
                        status: params.status || 'In Progress'
                    },
                    { new: true }
                );
                console.log('[reopen_task] Reopened task:', result);
                break;

            case 'fetch_tasks':
                const query = { user: userId };

                if (params.status) {
                    query.status = params.status;
                }
                if (params.completed !== undefined) {
                    query.completed = Boolean(params.completed);
                }
                if (params.priority) {
                    query.priority = params.priority;
                }
                if (params.tag) {
                    query.tags = params.tag;
                }
                if (params.tags && Array.isArray(params.tags)) {
                    query.tags = { $all: params.tags };
                }
                if (params.projectId) {
                    query.project = params.projectId;
                }
                if (params.startDate || params.endDate) {
                    query.dueDate = {};
                    if (params.startDate) {
                        query.dueDate.$gte = parseDateInput(params.startDate);
                    }
                    if (params.endDate) {
                        query.dueDate.$lte = parseDateInput(params.endDate);
                    }
                }
                if (params.search) {
                    query.$or = [
                        { title: { $regex: params.search, $options: 'i' } },
                        { description: { $regex: params.search, $options: 'i' } }
                    ];
                }
                console.log('[fetch_tasks] Query:', query);

                let sort = {};
                if (params.sortBy) {
                    const sortOrder = params.sortOrder === 'desc' ? -1 : 1;
                    sort[params.sortBy] = sortOrder;
                } else {
                    sort = {
                        [params.includeCompleted ? 'completedAt' : 'dueDate']: params.includeCompleted ? -1 : 1
                    };
                }
                console.log('[fetch_tasks] Sort:', sort);

                const limit = parseInt(params.limit) || 100;
                const skip = parseInt(params.skip) || 0;
                console.log('[fetch_tasks] Pagination limit:', limit, 'skip:', skip);

                result = await Task.find(query)
                    .sort(sort)
                    .skip(skip)
                    .limit(limit)
                    .populate('project', 'name color');
                console.log('[fetch_tasks] Result:', result);

                const totalCount = await Task.countDocuments(query);
                console.log('[fetch_tasks] Total count:', totalCount);

                return {
                    success: true,
                    response: "Here are your tasks",
                    tasks: result,
                    type: "tasks",
                    meta: {
                        total: totalCount,
                        returned: result.length,
                        limit,
                        skip
                    }
                };
        }
    } catch (err) {
        console.error('[handleTaskAction] Error:', err);
        return {
            success: false,
            error: err.message || 'Unknown error'
        };
    }

    console.log('[handleTaskAction] Success result:', result);
    return {
        success: true,
        data: result
    };
};

function validateParams(requiredFields, providedParams) {
    const missingFields = requiredFields.filter(field => {
        return providedParams[field] === undefined ||
            providedParams[field] === null ||
            (typeof providedParams[field] === 'string' && providedParams[field].trim() === '');
    });
    if (missingFields.length > 0) {
        console.log('[validateParams] Missing fields:', missingFields);
    }
    return missingFields.length > 0 ? missingFields : null;
}