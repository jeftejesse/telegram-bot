import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text || "";

  let reply =
    "Hmm… gostei que você veio 😌\n" +
    "Me conta, o que você quer por aqui?";

  if (text === "/start") {
    reply =
      "Oi… então é você 😏\n" +
      "A gente pode conversar um pouco… sem pressa.";
  }

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: reply,
    }),
  });

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot online 💬");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot rodando");
});
