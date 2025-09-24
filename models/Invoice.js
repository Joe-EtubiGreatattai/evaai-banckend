// models/Invoice.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* ---------- Subdocs ---------- */
const BrandSchema = new Schema(
  {
    name: String,
    tradingName: String,
    address: String,
    email: String,
    phone: String,
    number: String,       // company registration number
    vatNumber: String
  },
  { _id: false }
);

const ItemSchema = new Schema(
  {
    description: String,
    quantity: { type: Number, default: 1 },
    unitAmount: { type: Number, default: 0 },
    accountCode: String,
    vatPercent: Number,
    taxAmount: Number,
    lineAmount: Number
  },
  { _id: false }
);

/* ---------- Main schema ---------- */
const InvoiceSchema = new Schema(
  {
    // client
    clientName: String,
    clientEmail: String,
    clientAddress: String,

    // money
    amount: Number,
    currency: { type: String, default: 'GBP' },
    description: String,
    items: [ItemSchema],
    tasks: { type: Array, default: [] },

    // tax
    reverseCharge: { type: Boolean, default: false },
    vatPercent: Number,
    taxRate: Number,
    taxAmount: Number,
    discountAmount: Number,

    // issuer branding (rendered in PDF)
    brand: BrandSchema,
    businessName: String,
    businessEmail: String,
    businessPhone: String,
    businessAddress: String,
    companyNumber: String,
    vatNumber: String,

    // bank / payment (Payment Details - BACs)
    bankName: String,
    bankAddress: String,
    accountName: String,
    accountNumber: String,
    sortCode: String,
    iban: String,
    swiftBIC: String,
    paymentReference: String,
    paymentMethod: { type: String, default: 'BACs' },

    // visuals
    logoUrl: String,
    logoDataUrl: String,

    // meta
    invoiceNumber: String,
    reference: String,
    status: { type: String, default: 'Pending' },

    // dates
    date: Date,
    dueDate: Date,
    paidDate: Date,
    lastSent: Date,
    sentTo: String,

    // xero linkage
    xeroInvoiceId: String,
    xeroReference: String,
    xeroStatus: String,
    xeroSyncError: String,
    xeroSyncErrorDetails: String,

    // ownership
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true }
  },
  { timestamps: true }
);

/* ---------- Indexes ---------- */
InvoiceSchema.index({ user: 1, createdAt: -1 });
InvoiceSchema.index({ invoiceNumber: 1, user: 1 }, { sparse: true });

/* ---------- Export ---------- */
module.exports =
  mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);
