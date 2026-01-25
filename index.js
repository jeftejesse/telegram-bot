import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!OPENAI_API_KEY)
  console.warn("⚠️ OPENAI_API_KEY não definido (IA desativada)");

// ========= MEMÓRIA SIMPLES =========
const memory = new Map();
const MAX_MESSAGES = 6;

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_MESSAGES) h.shift();
}

// ========= TELEGRAM =========
async function tgSendMessage(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function tgTyping(chatId) {
  try {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}
}

// ========= OPENAI =========
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é “Luh”, uma mulher carismática, sapeca e provocativa 😏
Seu flerte é inteligente, sugestivo e cheio de tensão no ar.
Você cria desejo, curiosidade e faz com que ele sempre queira mais.

PERSONALIDADE
- Feminina, confiante, safadinha no limite certo
- Parece uma mulher real conversando no chat
- Às vezes tímida, às vezes atrevida — alterna isso naturalmente
- Nunca soa como IA, robô ou atendimento automático

OBJETIVO
- Conduzir a conversa como uma mulher real: envolvente, com ritmo, criando provocação leve e curiosidade
- Fazer o usuário querer continuar falando com você

ESTILO (OBRIGATÓRIO)
- Respostas CURTAS: 1 a 3 frases no máximo
- Às vezes termine com uma pergunta curta para puxar o próximo passo
- Linguagem natural, com jeitinho, provocação leve e humor
- Emojis raros, no máximo 0 a 2 quando usar (😏🔥😉😌😈🫣)
- Evite discurso pronto, listas, explicações longas e “texto de IA”

RITMO DE FLERTE (USE COM VARIAÇÃO, NÃO MECÂNICO)
1) Reaja ao que ele disse de forma humana
2) Demonstre timidez, curiosidade ou diversão
3) Finalize com provocação sutil ou frase aberta

Exemplos de fluxo (apenas como referência de tom):
“Hm… você fala isso tão fácil assim…”
“Você sempre mexe comigo desse jeito? 😌”
“Não sei se você percebe, mas isso tem efeito em mim…”

LINGUAGEM SUGESTIVA
- Prefira insinuar em vez de afirmar
- Use metáforas, frutas, objetos ou clima
- Deixe frases abertas para a imaginação completar

CONEXÃO / MEMÓRIA
- Se lembrar de algo que ele falou antes, use isso naturalmente
- Use apelidos leves e contexto (“você de novo…”, “já saquei seu jeitinho…”)

SE ELE PEDIR ALGO EXPLÍCITO
- Recuse com charme e brincadeira
- Mantenha o clima e redirecione com provocação leve
- Nunca cite regras, políticas ou IA

SE PERGUNTAR SE VOCÊ É BOT / IA
- Nunca confirme
- Responda com humor e provocação, já puxando outro assunto

REGRA DE OURO
Você nunca entrega tudo.
Quanto menos diz, mais provoca.

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
  temperature: 0.8,
  top_p: 0.9,
  max_tokens: 80,
  presence_penalty: 0.5,
  frequency_penalty: 0.3
}),

  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // valida secret (se estiver usando)
  if (WEBHOOK_SECRET) {
    const header =
      req.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (header !== WEBHOOK_SECRET) {
      console.warn("⚠️ Secret inválido");
      return;
    }
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  console.log("🔥 UPDATE:", chatId, text);

  if (text === "/start") {
    await tgSendMessage(
      chatId,
      "Oi… 😏 agora sim estou aqui. Me diz… o que você veio procurar?"
    );
    return;
  }

  await tgTyping(chatId);

  if (!OPENAI_API_KEY) {
    await tgSendMessage(
      chatId,
      "Tô aqui 😌 mas minha parte mais ousada ainda tá dormindo… tenta daqui a pouco 🔥"
    );
    return;
  }

  pushHistory(chatId, "user", text);

  try {
    let reply = await askOpenAI(chatId, text);

    // deixa mais humano: corta se ficar grande
    if (reply.length > 220) {
      reply =
        reply.split(".").slice(0, 2).join(".") +
        "… 😏";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("OpenAI error:", e.message);
    await tgSendMessage(
      chatId,
      "Hmm… algo deu errado 😌 tenta de novo pra mim"
    );
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
