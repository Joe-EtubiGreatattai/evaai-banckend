// routes/eveDroppingRoutes.js
const express = require('express');
const eveDroppingController = require('../controllers/eveDroppingController');
const authController = require('../controllers/authController');
const multer = require('multer');

const router = express.Router();
const upload = multer();

router.use(authController.protect);

// Process meeting audio
router.post(
  '/process-meeting',
  upload.single('audio'),
  eveDroppingController.uploadMeetingAudio,
  eveDroppingController.processMeeting
);

// Save all meeting items
router.post(
  '/save-items',
  eveDroppingController.saveAllItems
);

// Save individual task
router.post(
  '/save-task',
  eveDroppingController.saveTask
);

// Save individual event
router.post(
  '/save-event',
  eveDroppingController.saveEvent
);

// Save individual invoice
router.post(
  '/save-invoice',
  eveDroppingController.saveInvoice
);

// // Get meeting history
// router.get(
//   '/meetings',
//   eveDroppingController.getMeetingHistory
// );

// // Get specific meeting by ID
// router.get(
//   '/meetings/:meetingId',
//   eveDroppingController.getMeetingById
// );

// // Delete meeting by ID
// router.delete(
//   '/meetings/:meetingId',
//   eveDroppingController.deleteMeeting
// );

module.exports = router;