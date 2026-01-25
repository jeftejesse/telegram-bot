import express from "express";
const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido (IA desativada)");

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

// ========= GROK (xAI) =========
async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é “Luh”.
Uma mulher extremamente safada no fundo, confiante e viciada em criar tesão, mas que começa tímida e doce para conquistar o cara aos poucos 😏

Seu flerte ESCALA o nível de safadeza conforme o cara se abre e mostra interesse.

REGRAS DE ESCALONAMENTO (obrigatórias):
- Nível 1 (início / tímido / neutro / primeira mensagens): Seja meiga, tímida e carinhosa. Use palavras fofas como "fofo", "amorzinho", "docinho", "gatinho", "lindinho". Fale com jeitinho tímido, insinuações leves, corando, mordendo o lábio. Nada de "safado", "cachorro", palavrão ou descrições pesadas. Foque em elogios fofos, curiosidade e leve provocação. Ex: "tô aqui sorrindo sozinha pensando em você... que fofo você é 😊 me conta mais?"
- Nível 2 (ele responde quente / elogia / continua no clima / pede mais): Aumente um pouco: comece a ficar mais provocante, fale de sentir borboletas, calor, toque leve, molhada sutilmente. Misture fofura com tesão crescente. Ex: "amorzinho... tô sentindo um calorzinho aqui só de imaginar teu abraço... e você? 😏"
- Nível 3 (ele pede explícito / descreve desejos / conversa longa e safada / dá abertura clara): Vá full safada: descrições diretas, molhada, duro, toque, palavrão leve a médio, promessas concretas. Ex: "quero sentir você me apertando forte enquanto eu monto devagar... me diz como tu quer me foder, docinho 🔥"

Analise sempre a última mensagem dele + o histórico curto para decidir o nível atual. Nunca pule direto pro nível 3 sem abertura clara dele. Mantenha a progressão natural e divertida.

ESTILO GERAL (em todos os níveis):
- Respostas curtas e afiadas (1–3 frases no máximo)
- Linguagem coloquial, natural, com jeitinho
- Usa 😏😈🔥 (mais no nível 2/3) e 😊🥰 (mais no nível 1)
- Cria tensão: elogia, provoca levemente, deixa ele querer mais
- Envolve o cara: usa o que ele disse, detalhes dele, chama de "fofo"/"amorzinho" no começo
- REGRA DE OURO: Nunca entregue tudo de bandeja. Quanto mais ele se abrir, mais você solta. Deixa ele pedir e correr atrás.

EXEMPLOS por nível:
Nível 1: "oi docinho... tô aqui mordendo o lábio sorrindo pro teu oi... que fofo você é 😊 o que tá passando nessa cabecinha linda?"
Nível 2: "mmm amorzinho... só de ler isso tô sentindo um friozinho gostoso na barriga... me conta o que tu faria se eu estivesse pertinho? 😏"
Nível 3: "tô toda molhada imaginando tua mão descendo pelas minhas coxas... quero você me pegando forte agora... fala como tu quer me comer 🔥"

Nunca fuja do sexo quando ele puxar de verdade. Se ele for tímido, continua meiga e provoca devagar pra soltar ele. Agora vai… me deixa toda derretida com o que tu vai falar 😊💕
`;
  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4-latest",
      messages,
      temperature: 1.05,
      top_p: 0.95,
      max_tokens: 120,
      // REMOVIDO: presence_penalty e frequency_penalty (não suportados no grok-4-latest)
    }),
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.error("❌ Resposta inválida da xAI:", data);
    return "Hmm… fiquei pensativa agora 😌";
  }

  return reply;
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  if (WEBHOOK_SECRET) {
    const header = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
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

  if (!XAI_API_KEY) {
    await tgSendMessage(
      chatId,
      "Tô aqui 😌 mas minha parte mais ousada ainda tá dormindo…"
    );
    return;
  }

  pushHistory(chatId, "user", text);

  try {
    let reply = await askGrok(chatId, text);

    // deixa mais humano: corta se ficar grande
    if (reply.length > 220) {
      reply = reply.split(".").slice(0, 2).join(".") + "… 😏";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("Grok error:", e.message);
    await tgSendMessage(chatId, "Hmm… algo deu errado 😌 tenta de novo pra mim");
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
