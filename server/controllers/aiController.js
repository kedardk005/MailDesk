const { GoogleGenerativeAI } = require('@google/generative-ai');

// @desc    Summarize an email body using Gemini
// @route   POST /api/ai/summarize-email
// @access  Private (Admin, Head only)
exports.summarizeEmail = async (req, res) => {
  try {
    const { subject, from, body } = req.body;

    if (!body && !subject) {
      return res.status(400).json({ message: 'Email subject or body is required for summarization.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: 'AI service is not configured. GEMINI_API_KEY missing.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Strip HTML tags for a cleaner prompt
    const plainBody = body
      ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000)
      : '';

    const prompt = `You are a business email assistant. Summarize the following email in exactly 3-4 concise bullet points.
Each bullet must start with "• ".
Focus on: the main request or purpose, any action items, deadlines or urgency, and key information.
Keep each bullet under 20 words.

Email Subject: ${subject || '(No Subject)'}
From: ${from || 'Unknown'}
Body: ${plainBody || '(No body content)'}

Respond with only the bullet points, nothing else.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    return res.status(200).json({ summary: text });
  } catch (error) {
    console.error('Error in summarizeEmail:', error);
    if (error.message?.includes('API_KEY')) {
      return res.status(550).json({ message: 'Invalid Gemini API key.' });
    }
    return res.status(500).json({ message: 'AI summarization failed. Please try again.' });
  }
};
