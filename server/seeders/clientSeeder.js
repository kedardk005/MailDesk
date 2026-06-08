const Client = require('../models/Client');

/**
 * Seeds 10 sample client names into the Client collection if they do not already exist.
 */
const seedClients = async () => {
  const sampleClients = [
    "Reliance Industries",
    "Tata Consultancy",
    "Infosys",
    "HDFC Bank",
    "Wipro",
    "HCL Technologies",
    "Mahindra Group",
    "Bajaj Auto",
    "ICICI Bank",
    "Adani Group"
  ];

  try {
    for (const name of sampleClients) {
      // Check if client name already exists
      const exists = await Client.findOne({ name });
      if (!exists) {
        const client = new Client({ name });
        await client.save();
        console.log(`Seeded client: ${name}`);
      }
    }
    console.log("Client seeding checks completed successfully.");
  } catch (error) {
    console.error("Error seeding clients:", error);
  }
};

module.exports = { seedClients };
