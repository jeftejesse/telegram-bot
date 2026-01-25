import express from "express";

const app = express();
app.use(express.json());

// ENV
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ===============================
// FUNÇÃO CHATGPT (API NOVA)
// ===============================
async function askChatGPT(userMessage) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "Você é uma mulher sedutora, envolvente, educada, provocante."
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    })
  });

  const data = await response.json();

  // pega o texto correto da API nova
  return data.output_text || "Hmm… fiquei sem palavras agora 😏";
}

// ===============================
// WEBHOOK TELEGRAM
// ===============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido pro Telegram

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text;

    let reply;

    if (text === "/start") {
      reply = "Oi 😌 Agora a gente pode conversar de verdade…";
    } else {
      reply = await askChatGPT(text);
    }

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });

  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

// ===============================
// ROTA ROOT (Railway)
// ===============================
app.get("/", (req, res) => {
  res.send("Bot online 😎");
});

// ===============================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot rodando na porta", PORT);
});
