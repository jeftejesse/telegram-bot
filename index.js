import express from "express";

// Node 18+ já tem fetch nativo (Railway com Node 22 tem).
// Então não precisa node-fetch.

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== ENV VARS ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Railway costuma expor PORT automaticamente
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) console.error("❌ Falta BOT_TOKEN nas variáveis de ambiente.");
if (!OPENAI_API_KEY) console.error("❌ Falta OPENAI_API_KEY nas variáveis de ambiente.");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ====== Memória simples por chat (últimas N mensagens) ======
const memory = new Map(); // chatId -> [{role, content}, ...]
const MAX_TURNS = 12; // 12 mensagens no histórico (6 idas e 6 voltas aprox)

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}
function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  // corta o excesso
  while (h.length > MAX_TURNS) h.shift();
}

// ====== Helpers ======
async function sendTelegramMessage(chatId, text) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // parse_mode: "HTML", // se quiser usar HTML no texto
      // disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Telegram sendMessage erro: ${resp.status} ${errTxt}`);
  }
}

async function askOpenAI(chatId, userText) {
  // prompt base (ajuste como quiser)
  const systemPrompt =
    "Você é uma assistente simpática, envolvente e educada. " +
    "Converse de forma natural e respeitosa. " +
    "Não produza conteúdo sexual explícito.";

  const history = getHistory(chatId);

  // Monta mensagens (system + histórico + user)
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.8,
    }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg =
      data?.error?.message ||
      JSON.stringify(data) ||
      `HTTP ${resp.status}`;
    throw new Error(`OpenAI erro: ${msg}`);
  }

  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer || "Tive um branco aqui 😅 Pode repetir?";
}

// ====== Rotas ======
app.get("/", (req, res) => {
  res.status(200).send("Bot online ✅");
});

// Webhook do Telegram (IMPORTANTE: o endpoint tem que existir)
app.post("/webhook", (req, res) => {
  // Telegram precisa receber 200 rápido, senão ele considera falha
  res.sendStatus(200);

  // Processa em background (sem segurar a resposta do Telegram)
  setImmediate(async () => {
    try {
      const update = req.body;

      const message = update?.message;
      if (!message) return;

      const chatId = message.chat?.id;
      const text = message.text;

      if (!chatId || !text) return;

      // Comandos básicos
      if (text === "/start") {
        const welcome =
          "Oi! 😊 Agora estou funcionando certinho.\n" +
          "Me manda uma mensagem e eu respondo!";
        await sendTelegramMessage(chatId, welcome);
        return;
      }

      // Salva user no histórico
      pushHistory(chatId, "user", text);

      // Pede resposta à OpenAI
      const reply = await askOpenAI(chatId, text);

      // Salva assistant no histórico
      pushHistory(chatId, "assistant", reply);

      // Responde no Telegram
      await sendTelegramMessage(chatId, reply);
    } catch (err) {
      console.error("❌ Erro no webhook:", err?.message || err);

      // Tenta avisar o usuário se possível
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        try {
          await sendTelegramMessage(
            chatId,
            "Deu um erro aqui do meu lado 😕. Tenta de novo em alguns segundos."
          );
        } catch {}
      }
    }
  });
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
