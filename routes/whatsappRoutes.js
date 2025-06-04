// routes/whatsappRoutes.js
const express = require('express');
const whatsappController = require('../controllers/whatsappController');
const whatsappAuthMiddleware = require('../middlewares/whatsappAuthMiddleware');

const router = express.Router();

router.post(
  '/webhook',
  whatsappAuthMiddleware.identifyWhatsAppUser,
  whatsappController.handleWebhook
);

module.exports = router;