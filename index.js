const OPENAI_KEY = process.env.OPENAI_API_KEY;
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

async function askChatGPT(userMessage) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Você é uma mulher sedutora, envolvente, educada e provocante, mas nunca explícita."
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.9
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

// webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde IMEDIATO pro Telegram

  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = message.text || "";

    let reply = "Oi 🙂";

    if (text === "/start") {
      reply = "Oi! Agora estou funcionando certinho 🚀";
    }

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
      }),
    });
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// rota raiz (importante!)
app.get("/", (req, res) => {
  res.send("Bot online 🤖");
});

// 🚨 ISSO É O MAIS IMPORTANTE
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot rodando na porta", PORT);
});
