// server/scripts/encryptExistingTokens.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { encrypt } = require('../utils/tokenCrypto');

const migrate = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('MONGO_URI is not defined in environment variables.');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB.');

    const users = await User.find({});
    let updatedCount = 0;

    for (const user of users) {
      let userModified = false;

      // Primary token encryption
      if (user.gmailAccessToken && !user.gmailAccessToken.includes(':')) {
        user.gmailAccessToken = encrypt(user.gmailAccessToken);
        userModified = true;
      }
      if (user.gmailRefreshToken && !user.gmailRefreshToken.includes(':')) {
        user.gmailRefreshToken = encrypt(user.gmailRefreshToken);
        userModified = true;
      }

      // Linked accounts token encryption
      if (user.linkedGmailAccounts && user.linkedGmailAccounts.length > 0) {
        for (const acct of user.linkedGmailAccounts) {
          if (acct.gmailAccessToken && !acct.gmailAccessToken.includes(':')) {
            acct.gmailAccessToken = encrypt(acct.gmailAccessToken);
            userModified = true;
          }
          if (acct.gmailRefreshToken && !acct.gmailRefreshToken.includes(':')) {
            acct.gmailRefreshToken = encrypt(acct.gmailRefreshToken);
            userModified = true;
          }
        }
      }

      if (userModified) {
        // Mark modification explicitly for mixed/subdocument array fields in Mongoose
        user.markModified('linkedGmailAccounts');
        await user.save();
        updatedCount++;
        console.log(`Encrypted tokens for user: ${user.email}`);
      }
    }

    console.log(`Migration completed successfully. Encrypted tokens for ${updatedCount} users.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
};

migrate();
