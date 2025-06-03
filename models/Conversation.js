// models/Conversation.js
const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
    unique: true // One conversation per user
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update timestamp on save
conversationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Conversation = mongoose.model('Conversation', conversationSchema);
module.exports = Conversation;