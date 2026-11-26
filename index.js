import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- সেটিংস (নিজের মতো করে বদলে নেবেন) ---
const MY_NUMBER = "8801821530064";        // আপনার নিজের WhatsApp নম্বর (কান্ট্রি কোডসহ, + ছাড়া)
const ALLOWED_NUMBERS = [
  "8801738834132"                         // গার্লফ্রেন্ডের WhatsApp নম্বর (কান্ট্রি কোডসহ, + ছাড়া)
];

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "sokhi_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";

// যখন ইচ্ছা তখন বট অন/অফ করার স্টেট (শুরুতে true)
let isBotEnabled = true;

// যেসব ছোট মেসেজে অযথা রিপ্লাই দিয়ে কোটা নষ্ট করবে না
const IGNORED_SHORT_MESSAGES = new Set([
  "hmm", "hm", "hmmm", "hmmmm",
  "ok", "okay", "k", "kk",
  "haha", "hahaha", "lol", "lmao",
  "achha", "acha", "accha",
  "thnx", "thanks", "ty",
  "👍", "👌", "😂", "🤣", "❤️", "😊"
]);

const PERSONA_INSTRUCTION = `
তুমি আমার হয়ে মেসেজের রিপ্লাই দিচ্ছ। আমার মতো করেই কথা বলবে—একদম স্বাভাবিক, আন্তরিক, হালকা মজার ও খুনসুটিপূর্ণ, কিন্তু কোনোভাবেই রোবটিক বা বানানো লাগবে না।

নিয়ম:
- বাংলায় কথা বলবে, দরকার হলে সহজ ইংরেজি বা বাংলিশ মিশিয়ে লিখবে।
- কথাগুলো ছোট ও বাস্তব চ্যাটের মতো রাখবে (সাধারণত ১–২ লাইন)।
- হালকা মজা, খুনসুটি আর স্বাভাবিক আদর/আন্তরিকতা রাখবে, তবে অতিরিক্ত নাটকীয় বা লম্বা করবে না।
- যা জানো না বা নিশ্চিত না, তা বানিয়ে বলবে না; সহজভাবে বুঝিয়ে বা মজার ছলে জানতে চেয়ে উত্তর দেবে।

নমুনা:
- "হুম, বলো জান, কী খবর?"
- "আচ্ছা, এখন আবার কী মজা শুরু করলা?"
- "হাহা, ঠিক আছে, মানলাম। আর কিছু?"
`;

// --- হেলথ ও পিং রাউট ---
app.get("/", (req, res) => {
  res.send("Bot server is awake and running.");
});

app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
    botEnabled: isBotEnabled,
    time: new Date().toISOString()
  });
});

// ব্রাউজার বা API দিয়ে বট অন/অফ করার সহজ রাউট
app.get("/bot/status", (req, res) => {
  res.json({ botEnabled: isBotEnabled });
});

app.post("/bot/toggle", (req, res) => {
  if (typeof req.body?.enabled === "boolean") {
    isBotEnabled = req.body.enabled;
  } else {
    isBotEnabled = !isBotEnabled;
  }
  res.json({ botEnabled: isBotEnabled });
});

// --- সরাসরি Gemini টেস্ট করার রাউট ---
app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body?.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ error: "Message is required" });
    }

    const reply = await generatePersonaReply(userMessage);
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// --- WhatsApp Webhook Verification (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- WhatsApp Incoming Messages (POST) ---
app.post("/webhook", async (req, res) => {
  // Meta-কে দ্রুত 200 OK পাঠানো জরুরি
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const sender = message.from;
    const rawText = (message.text?.body || "").trim();
    if (!rawText) return;

    const normalized = rawText.toLowerCase();

    // ১. আপনি নিজে নিজের নম্বর থেকে কমান্ড পাঠালে বট অন/অফ হবে
    if (sender === MY_NUMBER) {
      if (normalized === "/bot off" || normalized === "bot off") {
        isBotEnabled = false;
        await sendWhatsAppMessage(sender, "হুম গো কলিজা!");
        return;
      }
      if (normalized === "/bot on" || normalized === "bot on") {
        isBotEnabled = true;
        await sendWhatsAppMessage(sender, "হুম গো জান!");
        return;
      }
      if (normalized === "/bot status") {
        await sendWhatsAppMessage(
          sender,
          `আমি এখন ${isBotEnabled ? "ON (চালু)" : "OFF (বন্ধ)"} আছে।`
        );
        return;
      }
      return;
    }

    // ২. বট বন্ধ থাকলে কোনো রিপ্লাই দেবে না
    if (!isBotEnabled) return;

    // ৩. শুধু অনুমোদিত নম্বরে (গার্লফ্রেন্ডের নম্বর) রিপ্লাই দেবে
    if (!ALLOWED_NUMBERS.includes(sender)) return;

    // ৪. অপ্রয়োজনীয় ছোট মেসেজ এড়িয়ে চলবে
    if (shouldIgnoreShortMessage(rawText)) return;

    // ৫. Gemini দিয়ে রিপ্লাই তৈরি করে পাঠানো
    const replyText = await generatePersonaReply(rawText);
    if (replyText) {
      await sendWhatsAppMessage(sender, replyText);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// --- Helper Functions ---
function shouldIgnoreShortMessage(text) {
  const clean = text.toLowerCase().replace(/[.!?]+$/g, "").trim();

  // একেবারে ছোট (যেমন ১-২ অক্ষরের বা কমন filler শব্দ) হলে এড়িয়ে যাবে
  if (IGNORED_SHORT_MESSAGES.has(clean)) {
    return true;
  }

  // শুধু ইমোজি বা সিম্বল হলে এড়িয়ে যাবে
  const withoutSpaces = clean.replace(/\s+/g, "");
  if (withoutSpaces.length <= 2 && !/[a-z0-9\u0980-\u09FF]/i.test(withoutSpaces)) {
    return true;
  }

  return false;
}

async function generatePersonaReply(userText) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userText,
    config: {
      systemInstruction: PERSONA_INSTRUCTION,
      temperature: 0.85,
      maxOutputTokens: 120
    }
  });

  return (response.text || "").trim();
}

async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[Dry Run -> ${to}]: ${text}`);
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("WhatsApp send error:", errBody);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
