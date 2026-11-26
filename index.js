require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const PERSONA_INSTRUCTION = `
তুমি আমার হয়ে মেসেজের রিপ্লাই দিচ্ছ।
কথা বলবে স্বাভাবিক, আন্তরিক, বন্ধুসুলভ এবং সহজ ভাষায়।
রোবটিক বা অতিরিক্ত আনুষ্ঠানিক ভাষা ব্যবহার করবে না।
ব্যবহারকারী যে ভাষায় বা টোনে কথা বলবে, মানানসইভাবে সংক্ষিপ্ত ও স্বাভাবিক উত্তর দেবে।
`;

app.get('/', (req, res) => {
  res.status(200).send('Bot server is awake and running.');
});

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

async function generateReply(userMessage) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userMessage,
    config: {
      systemInstruction: PERSONA_INSTRUCTION,
      temperature: 0.7,
    },
  });

  return response.text || 'সরি, এখন রিপ্লাই তৈরি করা যাচ্ছে না।';
}

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Please provide a non-empty "message" string in JSON body.',
      });
    }

    const reply = await generateReply(message.trim());
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Gemini error:', err);
    return res.status(500).json({
      error: 'Failed to generate reply from Gemini.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
