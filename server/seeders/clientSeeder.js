const Client = require('../models/Client');

/**
 * Seeds 10 sample client names into the Client collection if they do not already exist.
 */
const seedClients = async () => {
  const sampleClients = [
    {
      name: "Reliance Industries",
      contactPerson: "Mukesh Sharma",
      email: "contact@reliance.com",
      phone: "+91 98200 11223",
      associatedEmails: ["billing@reliance.com", "support@reliance.com"],
      notes: "Enterprise client for logistics and cloud infrastructure.",
      status: "Active"
    },
    {
      name: "Tata Consultancy",
      contactPerson: "Rajesh Nambiar",
      email: "info@tcs.com",
      phone: "+91 98111 22334",
      associatedEmails: ["projects@tcs.com", "accounts@tcs.com"],
      notes: "Strategic IT services partner.",
      status: "Active"
    },
    {
      name: "Infosys",
      contactPerson: "Salil Mehta",
      email: "connect@infosys.com",
      phone: "+91 98333 44556",
      associatedEmails: ["vendor@infosys.com"],
      notes: "Digital transformation projects.",
      status: "Active"
    },
    {
      name: "HDFC Bank",
      contactPerson: "Sashi Varma",
      email: "corporate@hdfcbank.com",
      phone: "+91 98444 55667",
      associatedEmails: ["payments@hdfcbank.com"],
      notes: "Financial services and banking integration.",
      status: "Active"
    },
    {
      name: "Wipro",
      contactPerson: "Thierry Delaporte",
      email: "help@wipro.com",
      phone: "+91 98555 66778",
      associatedEmails: ["leads@wipro.com"],
      notes: "Global technology consulting.",
      status: "Active"
    }
  ];

  try {
    // Seeding is opt-in and first-run only.
    //
    // This previously ran on EVERY boot. Combined with taskHelper's
    // `clients[0].name` fallback it meant every unmatched email was attributed
    // to a seeded demo client ("Reliance Industries"), silently corrupting
    // per-client task and mail counts in reports.
    if (process.env.SEED_CLIENTS !== 'true') {
      return;
    }

    const existingCount = await Client.countDocuments({});
    if (existingCount > 0) {
      console.log('[SEED] Client collection is not empty — skipping client seeding.');
      return;
    }

    for (const item of sampleClients) {
      const client = new Client(item);
      await client.save();
      console.log(`Seeded client: ${item.name}`);
    }
    console.log('[SEED] Client seeding completed successfully.');
  } catch (error) {
    console.error('Error seeding clients:', error);
  }
};

module.exports = { seedClients };
