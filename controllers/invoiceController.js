// controllers/invoiceController.js
const Invoice = require('../models/Invoice');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

// Get all invoices with filtering
exports.getAllInvoices = catchAsync(async (req, res, next) => {
  const { status } = req.query;
  
  // Base query
  let query = Invoice.find({ user: req.user.id });
  
  // Apply status filter if provided
  if (status && ['Pending', 'Paid', 'Overdue'].includes(status)) {
    query = query.where('status').equals(status);
  }
  
  // Sort by date descending
  query = query.sort('-date');
  
  const invoices = await query;
  
  res.status(200).json({
    status: 'success',
    results: invoices.length,
    data: {
      invoices
    }
  });
});

// Get invoice counts by status
exports.getInvoiceCounts = catchAsync(async (req, res, next) => {
  const counts = await Invoice.aggregate([
    { $match: { user: req.user._id } },
    { $group: {
      _id: '$status',
      count: { $sum: 1 }
    }}
  ]);
  
  // Convert to object format
  const result = {
    all: 0,
    Pending: 0,
    Paid: 0,
    Overdue: 0
  };
  
  counts.forEach(item => {
    result.all += item.count;
    result[item._id] = item.count;
  });
  
  res.status(200).json({
    status: 'success',
    data: {
      counts: result
    }
  });
});

// Create a new invoice
exports.createInvoice = catchAsync(async (req, res, next) => {
  const { clientName, amount, date, dueDate, description } = req.body;
  
  const newInvoice = await Invoice.create({
    clientName,
    amount,
    date: new Date(date),
    dueDate: new Date(dueDate),
    description,
    user: req.user.id
  });
  
  res.status(201).json({
    status: 'success',
    data: {
      invoice: newInvoice
    }
  });
});

// Update an invoice
exports.updateInvoice = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { clientName, amount, status, date, dueDate, description } = req.body;
  
  const invoice = await Invoice.findOneAndUpdate(
    { _id: id, user: req.user.id },
    { clientName, amount, status, date: new Date(date), dueDate: new Date(dueDate), description },
    { new: true, runValidators: true }
  );
  
  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }
  
  res.status(200).json({
    status: 'success',
    data: {
      invoice
    }
  });
});

// Delete an invoice
exports.deleteInvoice = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  
  const invoice = await Invoice.findOneAndDelete({ _id: id, user: req.user.id });
  
  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }
  
  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Mark invoice as paid
exports.markAsPaid = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  
  const invoice = await Invoice.findOneAndUpdate(
    { _id: id, user: req.user.id },
    { status: 'Paid' },
    { new: true }
  );
  
  if (!invoice) {
    return next(new AppError('No invoice found with that ID', 404));
  }
  
  res.status(200).json({
    status: 'success',
    data: {
      invoice
    }
  });
});