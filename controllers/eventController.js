// controllers/eventController.js
const Event = require('../models/Event');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

// Helper function to filter by date range
const filterByDateRange = (query, date) => {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  return query.find({
    startTime: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });
};

// Get all events for a specific day
exports.getEventsByDay = catchAsync(async (req, res, next) => {
  const { date } = req.query;
  const selectedDate = date ? new Date(date) : new Date();
  
  let query = Event.find({ user: req.user.id });
  query = filterByDateRange(query, selectedDate);
  
  const events = await query.sort('startTime');
  
  res.status(200).json({
    status: 'success',
    results: events.length,
    data: {
      events
    }
  });
});

// Get events for a month (for calendar view)
exports.getEventsForMonth = catchAsync(async (req, res, next) => {
  const { year, month } = req.query;
  
  if (!year || !month) {
    return next(new AppError('Please provide year and month', 400));
  }
  
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  endDate.setHours(23, 59, 59, 999);
  
  const events = await Event.find({
    user: req.user.id,
    startTime: {
      $gte: startDate,
      $lte: endDate
    }
  });
  
  res.status(200).json({
    status: 'success',
    results: events.length,
    data: {
      events
    }
  });
});

// Create a new event
exports.createEvent = catchAsync(async (req, res, next) => {
  const { title, location, startTime, endTime } = req.body;
  
  const newEvent = await Event.create({
    title,
    location,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    user: req.user.id
  });
  
  res.status(201).json({
    status: 'success',
    data: {
      event: newEvent
    }
  });
});

// Update an event
exports.updateEvent = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { title, location, startTime, endTime } = req.body;
  
  const event = await Event.findOneAndUpdate(
    { _id: id, user: req.user.id },
    { title, location, startTime: new Date(startTime), endTime: new Date(endTime) },
    { new: true, runValidators: true }
  );
  
  if (!event) {
    return next(new AppError('No event found with that ID', 404));
  }
  
  res.status(200).json({
    status: 'success',
    data: {
      event
    }
  });
});

// Delete an event
exports.deleteEvent = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  
  const event = await Event.findOneAndDelete({ _id: id, user: req.user.id });
  
  if (!event) {
    return next(new AppError('No event found with that ID', 404));
  }
  
  res.status(204).json({
    status: 'success',
    data: null
  });
});