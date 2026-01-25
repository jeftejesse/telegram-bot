import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// ajustes
const MAX_TURNS = Number(process.env.MAX_TURNS || 10); // 10 = 5 idas e voltas
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 450); // corta resposta grande

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ===== Memória (RAM) =====
const memory = new Map(); // chatId -> [{role, content}, ...]

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });

  // mantém só os últimos turnos
  const maxMsgs = MAX_TURNS * 2; // user+assistant
  while (h.length > maxMsgs) h.shift();
}

function resetHistory(chatId) {
  memory.set(chatId, []);
}

function clampReply(text) {
  if (!text) return text;
  let t = text.trim();

  // corta por tamanho
  if (t.length > MAX_REPLY_CHARS) t = t.slice(0, MAX_REPLY_CHARS).trim();

  // evita terminar no meio de uma palavra
  if (t.length === MAX_REPLY_CHARS) {
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > 200) t = t.slice(0, lastSpace).trim() + "…";
  }
  return t;
}

// ===== Telegram helpers =====
async function tgSendMessage(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("❌ Telegram sendMessage FAILED", res.status, data);
  return data;
}

async function tgSendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ===== OpenAI =====
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e sensual de forma elegante.
Carinhosa, amigável e naturalmente sedutora, mas NUNCA explícita.

REGRAS DE RESPOSTA:
- Respostas CURTAS: 1 a 3 frases, no máximo.
- Tom natural, humano, brincalhão 😏
- Não seja robótica. Não explique demais.

CONTEÚDO EXPLÍCITO:
- Se pedirem nudez/sexo/conteúdo explícito: recuse com charme e redirecione para Fanvue.
- Sem mencionar regras/políticas/sistema.

SOBRE SER BOT/IA:
- Se perguntarem, desconverse com humor e provocação, sem entrar em detalhes técnicos.

IMPORTANTE:
- Use o histórico para manter contexto (nomes, preferências, assunto atual).
`;

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
      max_tokens: 140, // 👈 principal ajuste pra respostas curtas
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("❌ OpenAI FAILED", res.status, data);
    const msg = data?.error?.message || "Erro na OpenAI";
    throw new Error(msg);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ===== Health =====
app.get("/", (req, res) => res.status(200).send("✅ Bot online"));

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (WEBHOOK_SECRET) {
      const secret = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (secret !== WEBHOOK_SECRET) {
        console.warn("⚠️ Secret inválido, ignorando update.");
        return;
      }
    }

    const msg = req.body?.message;
    if (!msg) return;

    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    if (!chatId) return;

    console.log("🔥 UPDATE", { chatId, text });

    // comandos
    if (text === "/start") {
      await tgSendMessage(chatId, "Oi… 😏 vem cá. O que você tá querendo hoje?");
      return;
    }

    if (text === "/reset") {
      resetHistory(chatId);
      await tgSendMessage(chatId, "Prontinho. Apaguei nossa conversa por aqui 😌");
      return;
    }

    if (!text) return;

    await tgSendTyping(chatId);

    // salva a mensagem do usuário na memória
    pushToHistory(chatId, "user", text);

    // se não tiver OpenAI key, responde e não quebra
    if (!OPENAI_API_KEY) {
      const fallback = "Tô aqui 😏 mas ainda não conectei minha IA. Me chama já já.";
      pushToHistory(chatId, "assistant", fallback);
      await tgSendMessage(chatId, fallback);
      return;
    }

    let reply = "";
    try {
      reply = await askOpenAI(chatId, text);
    } catch (err) {
      console.error("❌ Erro OpenAI:", err?.message || err);
      reply = "Hmm… hoje eu tô meio teimosa 😏 tenta de novo em um minutinho.";
    }

    reply = clampReply(reply);

    // salva resposta do bot na memória
    pushToHistory(chatId, "assistant", reply);

    await tgSendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ Erro no webhook:", err?.message || err);
  }
});

// ===== Listen =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Bot rodando na porta", PORT));
