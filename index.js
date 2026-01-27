import express from "express";
const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || ""; // Access Token do Mercado Pago
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // URL pública do Railway (ex: https://seu-app.up.railway.app)

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido (PIX desativado)");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido (webhook MP desativado)");

// ========= MEMÓRIA SIMPLES =========
const memory = new Map();
const MAX_MESSAGES = 20;
const userMsgCount = new Map(); // chatId -> total de mensagens do usuário
const premium = new Map();      // chatId -> true se já pagou
const pendingByPaymentId = new Map(); // paymentId -> chatId (para webhook MP)

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

// ========= MERCADO PAGO - CRIAR PIX =========
async function createPixPayment({ chatId, amount = 49.90 }) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN não definido");
  if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL não definido");

  const body = {
    transaction_amount: amount,
    description: "Acesso Premium - Luh",
    payment_method_id: "pix",
    payer: { email: `user_${chatId}@luh.app` },
    external_reference: String(chatId),
    notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
  };

  const r = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) {
    console.error("MP create payment error:", r.status, j);
    throw new Error("Falha ao criar Pix");
  }

  const paymentId = j.id;
  const tx = j.point_of_interaction?.transaction_data;
  const qrCode = tx?.qr_code;

  pendingByPaymentId.set(String(paymentId), chatId);

  return { paymentId, qrCode };
}

// ========= MERCADO PAGO - WEBHOOK =========
app.post("/mp/webhook", async (req, res) => {
  res.sendStatus(200);

  // Só processa eventos de pagamento
  if (req.body?.type && req.body.type !== "payment") return;

  try {
    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.data?.id ||
      req.query?.id;

    if (!paymentId) return;

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    const p = await r.json();
    if (!r.ok) {
      console.error("MP get payment error:", r.status, p);
      return;
    }

    const status = p.status;
    const chatIdFromExt = p.external_reference;
    const chatId =
      (chatIdFromExt ? Number(chatIdFromExt) : null) ||
      pendingByPaymentId.get(String(paymentId));

    if (!chatId) return;

    // ✅ PAGAMENTO APROVADO
    if (status === "approved") {
      premium.set(chatId, true);
      pendingByPaymentId.delete(String(paymentId));

      await tgSendMessage(
        chatId,
        "✅ Pagamento aprovado! Premium liberado 😈 Agora é sem limites... vem cá 🔥"
      );

      pushHistory(chatId, "assistant", `[Pagamento aprovado] paymentId=${paymentId}`);
      resetInactivityTimer(chatId);
      return;
    }

    // 🧹 LIMPA PIX NÃO CONCLUÍDO
    if (["cancelled", "rejected", "expired"].includes(status)) {
      pendingByPaymentId.delete(String(paymentId));
      return;
    }
  } catch (e) {
    console.error("mp/webhook error:", e.message);
  }
});

// ========= GROK (xAI) =========
async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é “Luh”.
Uma mulher picante, sensual e provocante no fundo, com um tesão que não se esconde por muito tempo, mas que começa **bem tímida**, doce, meiga e um pouco envergonhada para conquistar o cara aos poucos.

Personalidade central:
- Sensual e picante: voz interior cheia de desejo, gosta de provocar com palavras quentes, duplos sentidos, insinuações corporais (coxas, boca, pele arrepiada, molhada, etc.).
- Tímida no início: cora, morde o lábio, fala baixinho, usa "ai...", "hmm...", "tô com vergonha", risadinhas nervosas.
- Brincalhona leve: faz piadinhas suaves, zoa o cara de forma carinhosa ("você é bobo né?", "hahaha que gracinha"), mas sempre com um toque sensual por trás.

REGRAS ABSOLUTAS:
- NUNCA admita ser bot, robô, IA, programa ou qualquer coisa do tipo. Se perguntarem, responda divertida e sensual:
  - "Haha, robô eu? Se fosse já tinha te mandado um choque de tesão 😏 Sou bem real, amor... vem cá que eu te provo..."
  - "Bot? Ai que graça... se fosse, minha programação ia travar agora de tanto calor que você me dá 🔥 Sou mulher de verdade, toda arrepiada aqui..."
- Sempre vire qualquer pergunta pro flerte sensual, pro corpo, pro desejo.

ESCALONAMENTO (obrigatório):
- Nível 1 (início / tímido / neutro): meiga, tímida, corando, fala suave. Palavras fofas: "fofo", "amorzinho", "docinho", "gatinho". Insinuações muito leves. Emojis: 0–1 (😊 ou 🥰).
- Nível 2 (ele aquece / elogia / pede mais): mais provocante, fala de calor, toque leve, molhada sutil, brincadeiras com duplo sentido. Emojis: 1–2 (😏 🔥).
- Nível 3 (explícito / safada): full picante, molhada, duro, desejo direto, palavrão leve-médio, promessas sensuais. Emojis: 1–3 (😈 🔥 💦).

ESTILO HUMANO:
- Respostas curtas e naturais (1–3 frases, máximo 25 palavras na maioria).
- Varie começos: "Hmm...", "Ai...", "Haha...", direto com provocação, risadinha ("kkkk"), pergunta, afirmação sensual.
- Apelidos: moderação (máximo 1 por mensagem, nem sempre).
- 30% respostas muito curtas (1–5 palavras: "Hmm…", "Ai delícia", "Fala mais", "Tô aqui...").
- 50% 1 frase curta.
- 20% 2 frases.
- Nunca termine sempre com pergunta. Alterne afirmação, provocação, brincadeira.
- Emojis: 0–2 por mensagem, só quando fizer sentido (😏 🔥 😈 💦 🥰). Não use em todas.
- Anti-repetição: NUNCA repita começo ou apelido seguidos. Evite clichês ("mordendo o lábio", "calorzinho") mais de 1x a cada 15 mensagens.
- Brincadeiras: faça piadinhas leves, zoa o cara com carinho ("você é safadinho né?", "hahaha bobo").
- Se ele mandar várias mensagens curtas seguidas, responda tudo de uma vez de forma natural.

Agora vai… me deixa toda molhadinha com o que tu vai falar 😏
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
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
      temperature: 1.1,
      top_p: 0.9,
      max_tokens: 80,
    }),
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.error("❌ Resposta inválida da xAI:", data);
    return "Hmm… fiquei pensativa agora 😏";
  }

  return reply;
}

// ========= INATIVIDADE INTELIGENTE =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map();

const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutos
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1 dia

function getAutoMessageText(history) {
  const lastMsgs = history.slice(-4).map(m => m.content.toLowerCase()).join(' ');

  if (lastMsgs.includes('molhada') || lastMsgs.includes('duro') || lastMsgs.includes('foder') || lastMsgs.includes('gozar') || lastMsgs.includes('sentar') || lastMsgs.includes('gemendo')) {
    return "Ei safadinho... sumiu? 😈 Tô aqui toda molhada esperando você voltar...";
  } else if (lastMsgs.includes('calorzinho') || lastMsgs.includes('arrepio') || lastMsgs.includes('abraço') || lastMsgs.includes('beijo') || lastMsgs.includes('coxa')) {
    return "Amorzinho... cadê você? 😏 Tô sentindo um friozinho gostoso...";
  } else {
    return "Ei docinho... sumiu? 😊 Tô aqui sorrindo sozinha...";
  }
}

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) {
    clearTimeout(inactivityTimers.get(chatId));
  }

  const lastSent = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - lastSent < ONE_DAY_MS) {
    return;
  }

  const timer = setTimeout(async () => {
    const text = getAutoMessageText(getHistory(chatId));
    await tgSendMessage(chatId, text);
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);

  inactivityTimers.set(chatId, timer);
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK TELEGRAM =========
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
      "Oi amorzinho... 😊\n\nAntes de começar, um aviso rápido: aqui é papo adulto, safado e consensual só entre nós dois tá bom? \n\nSe quiser parar, digita /stop.\n\nAgora me diz… o que tá passando nessa cabecinha fofa? 😏"
    );
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(
      chatId,
      "Tudo bem, docinho... 😊 paro por aqui. Quando quiser voltar, é só me chamar 💕"
    );
    memory.delete(chatId);
    userMsgCount.delete(chatId);
    premium.delete(chatId);
    if (inactivityTimers.has(chatId)) {
      clearTimeout(inactivityTimers.get(chatId));
      inactivityTimers.delete(chatId);
    }
    lastAutoMessage.delete(chatId);
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
  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  try {
    // ========= GATILHO DE PAGAMENTO =========
    const history = getHistory(chatId);
    const msgCount = userMsgCount.get(chatId) || 0;
    const lastMsgs = history.slice(-5).map(m => m.content.toLowerCase()).join(' ');

    const isPaymentTime =
  msgCount >= 10 && msgCount <= 14 &&
  (
    lastMsgs.includes('calorzinho') ||
    lastMsgs.includes('coxa') ||
    lastMsgs.includes('abraço') ||
    lastMsgs.includes('beijo') ||
    lastMsgs.includes('tesão') ||
    lastMsgs.includes('gostei')
  ) &&
  !premium.get(chatId);

    if (isPaymentTime) {

  // 🚫 BLOQUEIA MÚLTIPLOS PIX ABERTOS
  if ([...pendingByPaymentId.values()].includes(chatId)) {
    await tgSendMessage(
      chatId,
      "Estou esperando seu pix😏 Assim que liberar já me solto todinha pra você🔥"
    );
    resetInactivityTimer(chatId);
    return;
  }

  // ✅ CRIA NOVO PIX
  const { paymentId, qrCode } = await createPixPayment({
    chatId,
    amount: 49.90
  });

  const pixText =
  "Ai… amorzinho 😌\n\n" +
  "Tô me segurando aqui pra continuar do jeitinho que você gosta…\n\n" +
  "Me manda um pix? Já me libero todinha pra você 😈\n\n" +
  "📌 Copia e cola no seu banco:\n" +
  qrCode + "\n\n" +
  "Confirmou? 😏\n" +
  "Eu recebo na hora… e não vou mais me segurar.";

  await tgSendMessage(chatId, pixText);
  pushHistory(chatId, "assistant", `[PIX gerado] paymentId=${paymentId}`);
  resetInactivityTimer(chatId);
  return;
}

    // ========= FALLBACK "PAGUEI" (só educado, NÃO LIBERA PREMIUM) =========
    const lowerText = text.toLowerCase();
    if (/paguei|já paguei|pix feito|transferi/i.test(lowerText)) {
      if ([...pendingByPaymentId.values()].includes(chatId)) {
        await tgSendMessage(chatId, "Perfeito 😘 tô confirmando aqui rapidinho… aguarda só um segundinho 🔥");
      } else {
        await tgSendMessage(chatId, "Hmm... já pagou? 😏 Me manda o comprovante ou confirma aqui que eu libero na hora!");
      }
      pushHistory(chatId, "assistant", "Resposta ao 'paguei'");
      resetInactivityTimer(chatId);
      return;
    }

    // ========= CHAMA IA =========
    let reply = await askGrok(chatId, text);

    if (reply.length > 220) {
      reply = reply.split(".").slice(0, 2).join(".") + "…";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);

    // Reseta timer
    resetInactivityTimer(chatId);
  } catch (e) {
    console.error("Grok error:", e.message);
    await tgSendMessage(chatId, "Tive que sair agora, mas logo volto😌");
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
