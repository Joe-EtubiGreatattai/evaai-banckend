// routes/invoiceRoutes.js
const express = require('express');
const invoiceController = require('../controllers/invoiceController');
const authController = require('../controllers/authController');

const router = express.Router();

// Protect all routes after this middleware
router.use(authController.protect);

router
  .route('/')
  .get(invoiceController.getAllInvoices)
  .post(invoiceController.createInvoice);

router.get('/counts', invoiceController.getInvoiceCounts);

router
  .route('/:id')
  .patch(invoiceController.updateInvoice)
  .delete(invoiceController.deleteInvoice);

router.patch('/:id/mark-paid', invoiceController.markAsPaid);

module.exports = router;