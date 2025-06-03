// routes/chatRoutes.js
const express = require('express');
const chatController = require('../controllers/chatController');
const authController = require('../controllers/authController');
const multer = require('multer');

const router = express.Router();

const upload = multer();

router.use(authController.protect);

router
  .route('/conversation')
  .get(chatController.getConversation)
  .delete(chatController.clearConversation);

router.post('/message', chatController.sendMessage);
router.get('/suggestions', chatController.getSuggestions);


router.post('/transcribe', upload.single('audio'), chatController.transcribeAudio);

module.exports = router;