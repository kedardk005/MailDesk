const mongoose = require('mongoose');
const { seedClients } = require('../seeders/clientSeeder');

/**
 * Connects to MongoDB database using MONGO_URI from environment variables.
 */
const connectDB = async () => {
  try {
    // connect using the connection string from env
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    // Seed sample clients
    await seedClients();

    // Clean up emails that were incorrectly assigned to Admin/Head users without a task link
    const Email = require('../models/Email');
    const Task = require('../models/Task');
    const tasks = await Task.find({ linkedEmail: { $ne: null } }).select('linkedEmail');
    const linkedEmailIds = tasks.map(t => t.linkedEmail.toString());
    const result = await Email.updateMany(
      { _id: { $nin: linkedEmailIds } },
      { status: 'unassigned', assignedTo: null }
    );
    if (result.modifiedCount > 0) {
      console.log(`[CLEANUP] Reset ${result.modifiedCount} emails with no tasks to unassigned status.`);
    }
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    // Log the error but do not crash the process, allowing server health check to run
  }
};

module.exports = connectDB;
