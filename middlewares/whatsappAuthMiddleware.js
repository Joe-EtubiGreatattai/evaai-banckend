// middlewares/whatsappAuthMiddleware.js
const User = require('../models/User');
const AppError = require('../utils/appError');

exports.identifyWhatsAppUser = async (req, res, next) => {
  try {
    // Extract and format phone number (remove 'whatsapp:' prefix)
    const rawNumber = req.body.From;
    const whatsappNumber = rawNumber.startsWith('whatsapp:') 
      ? rawNumber.replace('whatsapp:', '')
      : rawNumber;
      
    const profileName = req.body.ProfileName || 'WhatsApp User';

    if (!whatsappNumber) {
      return next(new AppError('Phone number is required', 400));
    }

    // Find or create user
    let user = await User.findOneAndUpdate(
      { phoneNumber: whatsappNumber },
      { 
        $setOnInsert: {
          phoneNumber: whatsappNumber,
          whatsappProfileName: profileName,
          isWhatsAppUser: true,
          fullName: profileName
        }
      },
      { 
        upsert: true,
        new: true,
        setDefaultsOnInsert: true 
      }
    );

    req.user = user;
    next();
  } catch (error) {
    console.error('WhatsApp auth error:', error);
    next(new AppError('Error processing WhatsApp authentication', 500));
  }
};