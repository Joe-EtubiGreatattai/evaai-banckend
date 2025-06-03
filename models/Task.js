// models/Task.js
const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please provide a task title'],
    trim: true,
  },
  description: {
    type: String,
    default: '',
    trim: true
  },
  completed: {
    type: Boolean,
    default: false,
  },
  completedAt: {
    type: Date,
    default: null
  },
  dueDate: {
    type: Date,
    default: Date.now, // Default to today
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High'],
    default: 'Medium'
  },
  status: {
    type: String,
    default: 'Not Started',
    enum: ['Not Started', 'In Progress', 'Completed', 'On Hold']
  },
  tags: {
    type: [String],
    default: []
  },
  project: {
    type: mongoose.Schema.ObjectId,
    ref: 'Project'
  },
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

const Task = mongoose.model('Task', taskSchema);
module.exports = Task;