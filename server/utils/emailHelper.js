const nodemailer = require('nodemailer');

// Setup transporter using Gmail service
// It expects SENDER_EMAIL and SENDER_APP_PASSWORD in environment variables
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SENDER_EMAIL,
    pass: process.env.SENDER_APP_PASSWORD
  }
});

/**
 * Sends an email using Gmail Nodemailer transporter
 * @param {String} to - Recipient email address
 * @param {String} subject - Email subject
 * @param {String} body - Email plain-text body
 * @param {String} [html] - Email HTML body (optional)
 */
const sendEmail = async (to, subject, body, html = null) => {
  try {
    const sender = process.env.SENDER_EMAIL;
    const password = process.env.SENDER_APP_PASSWORD;

    if (!sender || !password) {
      console.warn('[EMAIL WARNING] SENDER_EMAIL or SENDER_APP_PASSWORD not set in environment variables. Email sending aborted.');
      return null;
    }

    const mailOptions = {
      from: sender,
      to,
      subject,
      text: body
    };

    if (html) {
      mailOptions.html = html;
    }

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EMAIL SENT] to: ${to}, MessageID: ${info.messageId}, Subject: "${subject}"`);
    return info;
  } catch (error) {
    // Graceful error handling - log the issue, but do not throw to avoid crashing the server
    console.error('[EMAIL ERROR] Failed to send email via Nodemailer:', error);
    return null;
  }
};

module.exports = { sendEmail };
