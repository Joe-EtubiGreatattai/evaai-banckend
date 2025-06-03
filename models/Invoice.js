const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  clientName: {
    type: String,
    required: [true, 'Please provide client name'],
    trim: true,
    maxlength: [100, 'Client name cannot be more than 100 characters']
  },
  amount: {
    type: Number,
    required: [true, 'Please provide invoice amount'],
    min: [0, 'Amount cannot be negative']
  },
  status: {
    type: String,
    enum: ['Pending', 'Paid', 'Overdue'],
    default: 'Pending'
  },
  date: {
    type: Date,
    required: [true, 'Please provide invoice date'],
    default: Date.now
  },
  dueDate: {
    type: Date,
    required: [true, 'Please provide due date']
  },
  paidDate: {
    type: Date
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot be more than 500 characters']
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
invoiceSchema.index({ user: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ date: 1 });

// Calculate status before saving
invoiceSchema.pre('save', function(next) {
  const now = new Date();
  
  // If manually setting to Paid, ensure paidDate is set
  if (this.status === 'Paid' && !this.paidDate) {
    this.paidDate = now;
  }
  
  // If due date passed and not paid, mark as overdue
  if (this.status !== 'Paid' && this.dueDate < now) {
    this.status = 'Overdue';
  }
  
  next();
});

// Add query helper for paid invoices
invoiceSchema.query.paid = function() {
  return this.where({ status: 'Paid' });
};

// Add query helper for pending invoices
invoiceSchema.query.pending = function() {
  return this.where({ status: 'Pending' });
};

// Add query helper for overdue invoices
invoiceSchema.query.overdue = function() {
  return this.where({ status: 'Overdue' });
};

const Invoice = mongoose.model('Invoice', invoiceSchema);
module.exports = Invoice;