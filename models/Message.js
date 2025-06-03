// models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  text: {
    type: String,
    required: [true, 'Please provide message text'],
    trim: true,
    maxlength: [1000, 'Message cannot be more than 1000 characters']
  },
  sender: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  conversation: {
    type: mongoose.Schema.ObjectId,
    ref: 'Conversation',
    required: true
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

// Indexes for faster querying
messageSchema.index({ conversation: 1, createdAt: 1 });

const Message = mongoose.model('Message', messageSchema);
module.exports = Message;