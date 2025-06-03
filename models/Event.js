// models/Event.js
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please provide an event title'],
    trim: true,
    maxlength: [100, 'Title cannot be more than 100 characters']
  },
  location: {
    type: String,
    trim: true,
    maxlength: [100, 'Location cannot be more than 100 characters']
  },
  startTime: {
    type: Date,
    required: [true, 'Please provide a start time']
  },
  endTime: {
    type: Date,
    required: false, // Make endTime optional
    validate: {
      validator: function(value) {
        // Only validate if endTime is provided
        return !value || value > this.startTime;
      },
      message: 'End time must be after start time'
    }
  },
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster querying by user and date
eventSchema.index({ user: 1, startTime: 1 });

const Event = mongoose.model('Event', eventSchema);
module.exports = Event;