require("dotenv").config();
const nodemailer = require("nodemailer");

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASSWORD) {
  console.error("Missing EMAIL_USER or EMAIL_PASS in environment variables.");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASSWORD,
  },
});

/**
 * Service function to send an email
 * @param {Object} emailData - The email data object
 * @param {string} emailData.to - Recipient email address
 * @param {string} emailData.subject - Email subject
 * @param {string} [emailData.text] - Plain text body
 * @param {string} [emailData.html] - HTML body
 * @param {Array} [emailData.attachments] - Optional list of attachments (e.g., PDF buffer)
 * @returns {Promise<Object>} - Promise that resolves with send info or rejects with error
 */
const sendEmail = async (emailData) => {
  const { to, subject, text, html, attachments } = emailData;

  if (!to || !subject || (!text && !html)) {
    throw new Error("Missing required fields: to, subject, text or html");
  }

  const mailOptions = {
    from: `"Eva AI" <${EMAIL_USER}>`,
    to,
    subject,
    text,
    html,
    attachments, // 🔥 this line adds support for PDF or other file attachments
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, response: info.response };
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
};

module.exports = sendEmail;
