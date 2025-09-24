// models/User.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    // Identity
    fullName: { type: String, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      unique: true,
      sparse: true
    },
    phoneNumber: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true
    },

    // Company / issuer profile used on invoices
    companyName: { type: String, trim: true, default: '' },
    tradeType: { type: String, trim: true, default: '' }, // trading name / business type
    address: { type: String, trim: true, default: '' },
    vatNumber: { type: String, trim: true, default: '' },
    companyNumber: { type: String, trim: true, default: '' },

    // Payment details used on invoices (Payment Details - BACs)
    bankName: { type: String, trim: true, default: '' },
    bankAddress: { type: String, trim: true, default: '' },
    accountName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    sortCode: { type: String, trim: true, default: '' },
    iban: { type: String, trim: true, default: '' },
    swiftBIC: { type: String, trim: true, default: '' },
    paymentReference: { type: String, trim: true, default: '' },
    paymentMethod: { type: String, trim: true, default: 'BACs' },

    // Channels
    isWhatsAppUser: { type: Boolean, default: false },
    whatsappProfileName: { type: String, trim: true, default: '' },

    // Media
    avatarUrl: { type: String, trim: true, default: '' },

    // Auth (adapt as needed)
    passwordHash: { type: String, select: false },

    // Preferences / misc
    settings: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Compound index for fast lookups by phone or email
UserSchema.index({ phoneNumber: 1, email: 1 });

// Normalize phone to digits-only so lookups match what invoiceActions expects
UserSchema.pre('save', function normalizePhone(next) {
  if (this.isModified('phoneNumber') && this.phoneNumber) {
    this.phoneNumber = String(this.phoneNumber).replace(/\D/g, '');
  }
  next();
});

// Clean JSON output
UserSchema.set('toJSON', {
  virtuals: true,
  transform: (_, ret) => {
    delete ret.passwordHash;
    return ret;
  }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
