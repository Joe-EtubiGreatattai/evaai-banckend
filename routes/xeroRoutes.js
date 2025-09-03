const express = require('express');
const router = express.Router();
const XeroController = require('../controllers/xeroController');

// Connect user to Xero
router.get('/connect', XeroController.connect);

// OAuth callback
router.get('/callback', XeroController.callback);

// Invoice routes
router.post('/invoice', XeroController.createInvoice);
router.get('/invoice', XeroController.getInvoices);

module.exports = router;