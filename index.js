import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN; // do BotFather
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // sua key da OpenAI
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // opcional (recomendado)

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN no Railway Variables");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY no Railway Variables");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ====== Memória simples (por chat) ======
const memory = new Map(); // chatId -> [{role, content}, ...]
const MAX_TURNS = 12; // 12 mensagens = 6 idas e voltas (ajuste como quiser)

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}
function pushToHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  // corta histórico
  while (h.length > MAX_TURNS * 2) h.shift();
}

// ====== Telegram helpers ======
async function tgSendMessage(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // parse_mode: "HTML", // se quiser usar HTML
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("❌ Telegram sendMessage error:", res.status, data);
  }
  return data;
}

async function tgSendTyping(chatId) {
  // opcional: mostra “digitando…”
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ====== OpenAI call ======
// Aqui uso o endpoint Chat Completions (ainda suportado na doc) :contentReference[oaicite:0]{index=0}
async function askOpenAI(chatId, userText) {
  const systemPrompt =
    "Você é uma mulher sedutora, envolvente, educada e provocante, mas nunca explícita. " +
    "Converse de forma natural, divertida e com respostas humanas. " +
    "Se a pessoa pedir algo explícito, recuse com leveza e redirecione para algo não explícito, siga que o telegram bane o usuário se fizer isso, diz que se ele quizer fotos picantes ou algo explícito, pode entrar no perfil da fanvue.";

  const history = getHistory(chatId);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
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
      // max_tokens: 300, // se quiser limitar
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || "Erro desconhecido na OpenAI";
    throw new Error(`OpenAI ${res.status}: ${msg}`);
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("OpenAI respondeu sem texto (choices vazias).");

  return reply;
}

// ====== Health check ======
app.get("/", (req, res) => {
  res.status(200).send("✅ Bot online");
});

// ====== Webhook (Telegram) ======
app.post("/webhook", (req, res) => {
  // RESPONDE IMEDIATO pro Telegram (pra não dar timeout/502)
  res.sendStatus(200);

  // opcional: valida secret
  if (WEBHOOK_SECRET) {
    const secretHeader = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (secretHeader !== WEBHOOK_SECRET) {
      console.warn("⚠️ Webhook secret inválido, ignorando update.");
      return;
    }
  }

  // processa async
  (async () => {
    try {
      const update = req.body;

      const message = update?.message;
      if (!message) return;

      const chatId = message?.chat?.id;
      const text = (message?.text || "").trim();

      if (!chatId) return;

      // comandos básicos
      if (text === "/start") {
        await tgSendMessage(
          chatId,
          "Oi! 😏 Agora estou online. Me diz… o que você veio procurar por aqui?"
        );
        return;
      }

      if (!text) return;

      await tgSendTyping(chatId);

      // salva user no histórico
      pushToHistory(chatId, "user", text);

      // chama OpenAI
      let reply;
      try {
        reply = await askOpenAI(chatId, text);
      } catch (err) {
        console.error("❌ OpenAI error:", err?.message || err);
        // fallback mais útil (não aquela frase genérica)
        await tgSendMessage(
          chatId,
          "Deu um erro do meu lado 😕."
        );
        return;
      }

      // salva bot no histórico
      pushToHistory(chatId, "assistant", reply);

      await tgSendMessage(chatId, reply);
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
    }
  })();
});

// ====== Listen ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Bot rodando na porta", PORT));
