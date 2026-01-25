import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não configurado");
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY não configurada (IA desligada)");
if (!WEBHOOK_SECRET) console.warn("⚠️ WEBHOOK_SECRET não configurado");

// ================= MEMÓRIA (RAM) =================
const memory = new Map();
const MAX_TURNS = 8;

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function saveHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  while (history.length > MAX_TURNS * 2) history.shift();
}

// ================= TELEGRAM =================
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ================= OPENAI =================
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e carinhosa.
Respostas CURTAS, naturais e humanas.
Nunca explícita.

Se pedirem algo explícito:
- recuse com charme
- diga que aqui não pode
- convide para Fanvue

Se perguntarem se você é bot ou IA:
- nunca confirme
- desconverse com charme 😏
`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.9,
      max_tokens: 120,
    }),
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "Hmm… fala mais 😌";
}

// ================= HEALTH =================
app.get("/", (_, res) => {
  res.status(200).send("✅ Bot online");
});

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // valida secret
  if (WEBHOOK_SECRET) {
    const secret = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (secret !== WEBHOOK_SECRET) {
      console.warn("⚠️ Secret inválido, ignorando update");
      return;
    }
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  console.log("🔥 UPDATE:", text);

  // /start
  if (text === "/start") {
    await tgSendMessage(chatId, "Oi 😏 agora estou aqui… me diz, o que você veio procurar?");
    return;
  }

  await tgTyping(chatId);

  // SEM IA
  if (!OPENAI_API_KEY) {
    await tgSendMessage(chatId, "Tô aqui 😌 mas minha IA ai
