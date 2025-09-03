// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  fullName: {
    type: String,
    trim: true,
  },
  email: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      'Please provide a valid email',
    ],
  },
  phoneNumber: {
    type: String,
    unique: true,
    trim: true,
    validate: {
      validator: function (v) {
        // Accepts plain numbers 10–15 digits (e.g., WhatsApp numbers like 2348146139334)
        return /^\d{10,15}$/.test(v);
      },
      message: props => `${props.value} is not a valid phone number!`,
    },
  },
  tradeType: {
    type: String,
    trim: true,
  },
  password: {
    type: String,
    minlength: 8,
    select: false,
  },
  isWhatsAppUser: {
    type: Boolean,
    default: false,
  },
  whatsappProfileName: {
    type: String,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// 🔐 Encrypt password before saving (if changed)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// 🔐 Password checker method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);
module.exports = User;
