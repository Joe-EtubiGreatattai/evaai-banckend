// routes/eventRoutes.js
const express = require('express');
const eventController = require('../controllers/eventController');
const authController = require('../controllers/authController');

const router = express.Router();

// Protect all routes after this middleware
router.use(authController.protect);

router
  .route('/')
  .get(eventController.getEventsByDay)
  .post(eventController.createEvent);

router.get('/month', eventController.getEventsForMonth);

router
  .route('/:id')
  .patch(eventController.updateEvent)
  .delete(eventController.deleteEvent);

module.exports = router;