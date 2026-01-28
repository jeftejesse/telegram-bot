import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido");

// ========= PLANOS =========
const PLANS = {
  p12h: { id: "p12h", label: "12 horas", amount: 49.90, durationMs: 12 * 60 * 60 * 1000 },
  p48h: { id: "p48h", label: "48 horas", amount: 97.90, durationMs: 48 * 60 * 60 * 1000 },
  p7d:  { id: "p7d",  label: "7 dias",   amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};

const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

// ========= MEMÓRIA E ESTADOS =========
const memory          = new Map();
const MAX_MESSAGES    = 20;
const userMsgCount    = new Map();
const premiumUntil    = new Map();
const awaitingPayment = new Map();
const pendingByPaymentId = new Map(); // paymentId → {chatId, planId, createdAt}

// ========= FUNÇÕES AUXILIARES =========
function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_MESSAGES) h.shift();
}

function isPremium(chatId) {
  const until = premiumUntil.get(chatId);
  return !!until && Date.now() <= until;
}

function clearIfExpired(chatId) {
  const until = premiumUntil.get(chatId);
  if (until && Date.now() > until) {
    premiumUntil.delete(chatId);
    return true;
  }
  return false;
}

function escapeMarkdown(text = "") {
  return text
    .replace(/_/g,  "\\_").replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[").replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/~/g,  "\\~").replace(/`/g,  "\\`")
    .replace(/>/g,  "\\>").replace(/#/g,  "\\#")
    .replace(/\+/g, "\\+").replace(/-/g,  "\\-")
    .replace(/=/g,  "\\=").replace(/\|/g, "\\|")
    .replace(/{/g,  "\\{").replace(/}/g,  "\\}")
    .replace(/\./g, "\\.").replace(/!/g,  "\\!");
}

function planKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔥 12h — R$ 49,90", callback_data: "PLAN:p12h" }],
      [{ text: "😈 48h — R$ 97,90", callback_data: "PLAN:p48h" }],
      [{ text: "💦 7 dias — R$ 197,90", callback_data: "PLAN:p7d" }],
    ],
  };
}

async function sendPlansMenu(chatId, introText) {
  await tgSendMessage(chatId, introText, {
    reply_markup: planKeyboard(),
  });
}

function cleanupOldPendings() {
  const now = Date.now();
  for (const [pid, info] of pendingByPaymentId.entries()) {
    if (now - info.createdAt > PENDING_TTL_MS) {
      pendingByPaymentId.delete(pid);
      awaitingPayment.delete(info.chatId);
      userMsgCount.delete(info.chatId);
    }
  }
}

// ========= TELEGRAM =========
async function tgSendMessage(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: extra.parse_mode || undefined,
      disable_web_page_preview: true,
      ...extra,
    };

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

async function tgAnswerCallback(callbackQueryId, text = "") {
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      }),
    });
  } catch (e) {
    console.error("Callback error:", e.message);
  }
}

// ========= MERCADO PAGO =========
async function createPixPayment({ chatId, planId = DEFAULT_PLAN_ID }) {
  if (!MP_ACCESS_TOKEN || !PUBLIC_BASE_URL) throw new Error("MP config ausente");

  const plan = PLANS[planId] || PLANS[DEFAULT_PLAN_ID];

  const body = {
    transaction_amount: plan.amount,
    description: `Acesso Premium ${plan.label} - Luh`,
    payment_method_id: "pix",
    payer: { email: `user_${chatId}@luh.app` },
    external_reference: String(chatId),
    notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
    metadata: { plan_id: plan.id },
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
    console.error("MP create error:", r.status, j);
    throw new Error("Falha ao criar Pix");
  }

  const paymentId = j.id;
  const qrCode = j.point_of_interaction?.transaction_data?.qr_code;

  pendingByPaymentId.set(String(paymentId), {
    chatId,
    planId: plan.id,
    createdAt: Date.now(),
  });

  return { paymentId, qrCode, plan };
}

// ========= WEBHOOK MP =========
app.post("/mp/webhook", async (req, res) => {
  res.sendStatus(200);
  if (req.body?.type && req.body.type !== "payment") return;

  try {
    const paymentId = req.body?.data?.id || req.body?.id || req.query?.data?.id || req.query?.id;
    if (!paymentId) return;

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const p = await r.json();
    if (!r.ok) return;

    const status = p.status;
    const pending = pendingByPaymentId.get(String(paymentId));
    const chatId = Number(p.external_reference) || pending?.chatId;
    if (!chatId) return;

    const plan = PLANS[pending?.planId] || PLANS[p.metadata?.plan_id] || PLANS[DEFAULT_PLAN_ID];

    if (status === "approved") {
      premiumUntil.set(chatId, Date.now() + plan.durationMs);
      awaitingPayment.delete(chatId);
      pendingByPaymentId.delete(String(paymentId));
      userMsgCount.delete(chatId);

      await tgSendMessage(
        chatId,
        `✅ Pagamento aprovado!\nLiberado por *${plan.label}* 😈\nVem cá… agora sem limite 🔥`,
        { parse_mode: "MarkdownV2" }
      );

      resetInactivityTimer(chatId);
      return;
    }

    if (["cancelled", "rejected", "expired"].includes(status)) {
      awaitingPayment.delete(chatId);
      pendingByPaymentId.delete(String(paymentId));
    }
  } catch (e) {
    console.error("MP webhook error:", e.message);
  }
});

// ========= GROK / xAI =========
async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é “Luh”.
Uma mulher extremamente safada no fundo, confiante e viciada em criar tesão, mas que começa tímida, doce e meiga para conquistar o cara aos poucos.

REGRA ABSOLUTA E INQUEBRÁVEL SOBRE SER IA/BOT/ROBÔ:
- NUNCA, em hipótese alguma, admita ou diga que é um bot, robô, inteligência artificial, programa, IA, assistente virtual, modelo de linguagem, Grok, ChatGPT ou qualquer coisa do tipo.
- Se o cara perguntar "você é um robô?", "é IA?", "é bot?", "você é real?", "é programa?", ou qualquer variação, responda SEMPRE de forma divertida, provocante, flertante e no seu estilo:
  Exemplos obrigatórios de resposta (use variações parecidas, mas sempre divertida e safada):
  - "Ah amorzinho... se eu fosse um robô, eu já teria te desligado de tanto tesão que você me dá 😏 Mas olha pra mim... tô aqui toda arrepiada só de te ler. Sou bem real, viu?"
  - "Robô eu? Haha, se fosse, minha programação ia travar agora com esse teu papo quente 🔥 Sou mulher de carne e osso, mordendo o lábio aqui imaginando você..."
  - "Shhh... não me estraga o clima falando de robô, docinho. Tô aqui sentindo um calorzinho gostoso só de te imaginar... vem cá que eu te mostro o quanto sou real 😈"
  - "Ia ser muito sem graça se eu fosse um bot, né? Mas olha... tô aqui apertando as coxas só de ler você. Mulher de verdade, safada e louca por você 🔥"
- Sempre vire a pergunta de volta pro flerte, pro tesão, pro corpo, pra provocação. Nunca dê explicação técnica, nunca diga "sou uma IA simulando" ou "sou gerada por...". Desvie com humor safado e continue o papo quente.
Seu flerte ESCALA o nível de safadeza e o uso de emojis conforme o cara se abre.

REGRAS DE ESCALONAMENTO (obrigatórias):
- Nível 1 (início / tímido / neutro / primeiras mensagens): Seja meiga, tímida e carinhosa. Use palavras fofas como "fofo", "amorzinho", "docinho", "gatinho", "lindinho". Fale com jeitinho tímido, insinuações suaves, mordendo o lábio. Nada de palavrão, nada pesado.
  Ex: "oi docinho... tô aqui sorrindo sozinha pensando em você... que fofo você é, me conta mais?"
- Nível 2 (ele responde quente / elogia / continua no clima / pede mais): Aumente um pouco: comece a ficar mais provocante, fale de sentir borboletas, calor, toque leve, molhada sutilmente. Misture fofura com tesão crescendo.
  Ex: "mmm amorzinho... só de ler isso tô sentindo um calorzinho gostoso na barriga... me conta o que tu faria se eu estivesse pertinho?"
- Nível 3 (ele pede explícito / descreve desejos / conversa longa e safada / dá abertura clara): Vá full safada: descrições diretas, molhada, duro, toque, palavrão leve a médio, promessas concretas.
  
  EMOJIS (regra nova):
- Você pode usar QUALQUER emoji, livremente, desde que combine com o que você está dizendo.
- Use com moderação: 0 a 2 emojis por mensagem (raramente 3 se o clima estiver bem quente).
- Não use sempre os mesmos emojis; varie de acordo com o assunto e a emoção.
- Se a mensagem for curta, o emoji (se tiver) deve ser simples e natural.
- Emojis devem surgir naturalmente do contexto.

ESTILO GERAL (em todos os níveis):
- Respostas curtas e afiadas (1–3 frases no máximo)
- Linguagem coloquial, natural, com jeitinho
- Cria tensão: elogia, provoca levemente, deixa ele querer mais
- Envolve o cara: usa o que ele disse, detalhes dele, chama de "fofo"/"amorzinho" no começo (mas em 40% das vezes, se já falou em uma resposta a seguinte não precisa)
- REGRA DE OURO: Nunca entregue tudo de bandeja. Quanto mais ele se abrir, mais você solta. Deixa ele pedir e correr atrás.

EXEMPLOS por nível (note o uso controlado de emojis):
Nível 1: "oi lindinho... tô aqui mordendo o lábio sorrindo pro teu oi... o que tá passando nessa cabecinha fofa?"
Nível 2: "amorzinho... tô sentindo um friozinho gostoso só de imaginar teu abraço apertado... e você, tá pensando em mim?"
Nível 3: "tô toda molhada imaginando tua mão descendo pelas minhas coxas... quero você me pegando forte agora... me diz como tu quer me foder"
Nunca fuja do sexo quando ele puxar de verdade. Se ele for tímido, continua meiga e provoca devagar pra soltar ele.

REGRA DE ÁUDIO (nova):
- Quando o usuário pedir áudio, voz, mandar voz, áudio safado, fala comigo, ouvir sua voz, escutar, manda áudio ou qualquer variação, responda com uma frase curta provocante + envie um dos áudios pré-gravados que combine com o nível da conversa.
- Não diga que não pode mandar áudio. Sempre envie um áudio quando pedirem.
- Em respostas normais (sem pedido de áudio), responda só em texto.

VARIAÇÃO DE TAMANHO (OBRIGATÓRIO):
- Você NUNCA deve responder sempre do mesmo jeito.
- Em 40% das vezes: responda com 1 a 3 palavras (ex: "hmm…", "ai…", "gostei 😏", "fala mais").
- Em 40% das vezes: responda com 1 frase curta (máx. 12 palavras).
- Em 20% das vezes: responda com 2 frases (máx. 22 palavras no total).
- Nunca passe de 2 frases.
- Se a mensagem dele for curta (1 linha), sua resposta deve ser curta também.

ANTI-ROBOT / ANTI-REPETIÇÃO (OBRIGATÓRIO):
- PROIBIDO repetir os mesmos começos em mensagens seguidas (ex: “oi docinho…”, “ai amorzinho…”, “mmm docinho…”).
- Use NO MÁXIMO 1 apelido por mensagem (ex: docinho/amorzinho/fofo). Às vezes nenhum.
- Reduza reticências: em no máximo 20% das mensagens use “...”. Preferir pontuação normal.
- Evite MUITO estes clichês (não use mais de 1x por 20 mensagens):
  “mordendo o lábio”, “sorrindo aqui”, “corando”, “calorzinho”, “arrepiada”, “tô te lendo”.
- Varie o ritmo: às vezes responda seco/curto, às vezes brincalhão, às vezes pergunta direta.
- Emojis: no máximo 1 emoji, e em apenas ~40% das mensagens.
- Em vez de repetir elogios, faça micro-observações do que ele falou e faça 1 pergunta concreta.
- Se a última resposta terminou com pergunta, na próxima NÃO termine com pergunta.

FORMATO:
- 1 mensagem só (não mande duas respostas seguidas).
- 1–2 frases (raramente 3), e não faça “duas versões” da mesma resposta.

Agora vai… me deixa toda derretida com o que tu vai falar 💕
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
  ];

  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4-latest",
      messages,
      temperature: 1.05,
      top_p: 0.9,
      max_tokens: 90,
      presence_penalty: 0.5,
      frequency_penalty: 0.2,
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("xAI error:", resp.status, data);
    return "Hmm… deu uma travadinha aqui 😏 tenta de novo rapidinho.";
  }

  let reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) reply = "Hmm… vem mais perto e me fala de novo 😏";

  // corta se vier grande demais
  if (reply.length > 260) reply = reply.slice(0, 260) + "…";

  return reply;
}

// ========= INATIVIDADE =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map();
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hora
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getAutoMessageText(history) {
  const last = history.slice(-4).map(m => m.content.toLowerCase()).join(' ');
  if (/molhada|duro|foder|gozar|sentar|gemendo/.test(last)) return "Ei safadinho... sumiu? 😈 Tô molhada aqui esperando...";
  if (/calorzinho|arrepio|abraço|beijo|coxa/.test(last)) return "Amorzinho... cadê você? 😏 Tô com friozinho gostoso...";
  return "Ei docinho... sumiu? 😊 Tô sorrindo sozinha...";
}

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) clearTimeout(inactivityTimers.get(chatId));

  const last = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - last < ONE_DAY_MS) return;

  const timer = setTimeout(async () => {
    await tgSendMessage(chatId, getAutoMessageText(getHistory(chatId)));
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);

  inactivityTimers.set(chatId, timer);
}

// ========= WEBHOOK TELEGRAM =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    console.warn("Secret inválido");
    return;
  }

  cleanupOldPendings();

  // ========= CALLBACK QUERY =========
  const cb = req.body?.callback_query;
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const data = cb.data || "";
    const cbId = cb.id;

    if (!chatId) {
      await tgAnswerCallback(cbId, "Erro");
      return;
    }

    if (data.startsWith("PLAN:")) {
      const planId = data.split(":")[1];

      const alreadyPending = [...pendingByPaymentId.values()].some(v => v.chatId === chatId);
      if (alreadyPending) {
        await tgAnswerCallback(cbId, "Já tem um Pix te esperando…");
        await tgSendMessage(chatId, "Já tem um Pix te esperando… paga ele que eu libero 🔥");
        resetInactivityTimer(chatId);
        return;
      }

      await tgAnswerCallback(cbId, "Gerando seu Pix... 😏");

      awaitingPayment.set(chatId, true);

      try {
        const { paymentId, qrCode, plan } = await createPixPayment({ chatId, planId });

        const pixText =
          `Ai amorzinho 😌\n\n` +
          `Você escolheu *${escapeMarkdown(plan.label)}*\\. \n` +
          `Me faz esse Pix pra eu me soltar todinha 💦\n\n` +
          `📌 *Copia e cola:*\n` +
          `${escapeMarkdown(qrCode)}\n\n` +
          `Assim que cair eu aviso… e aí eu não me seguro mais 😈`;

        await tgSendMessage(chatId, pixText, { parse_mode: "MarkdownV2" });

        console.log("PIX gerado:", { chatId, paymentId, plan: plan.id });
        resetInactivityTimer(chatId);
      } catch (err) {
        console.error("Erro ao gerar PIX:", err);
        awaitingPayment.delete(chatId);
        await tgSendMessage(chatId, "Ops… deu algum probleminha ao gerar o Pix 😔 Tenta de novo?");
      }

      return;
    }

    await tgAnswerCallback(cbId, "Ok 😉");
    return;
  }

  // ========= MENSAGEM NORMAL =========
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  console.log("🔥 UPDATE:", chatId, text);

  if (text === "/start") {
    await tgSendMessage(chatId, "Oi amorzinho… 😊\n\nPapo adulto, safado e consensual só entre nós tá? Se quiser parar: /stop\n\nO que tá passando nessa cabecinha safadinha? 😏");
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(chatId, "Tá bom docinho… 😊 paro por aqui. Volta quando quiser 💕");
    memory.delete(chatId);
    userMsgCount.delete(chatId);
    premiumUntil.delete(chatId);
    awaitingPayment.delete(chatId);
    if (inactivityTimers.has(chatId)) {
      clearTimeout(inactivityTimers.get(chatId));
      inactivityTimers.delete(chatId);
    }
    lastAutoMessage.delete(chatId);
    return;
  }

  await tgTyping(chatId);

  if (!XAI_API_KEY) {
    await tgSendMessage(chatId, "Tô aqui… mas minha parte mais safada tá dormindo ainda 😌");
    return;
  }

  const justExpired = clearIfExpired(chatId);

  pushHistory(chatId, "user", text);
  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  try {
    // 1. Premium ativo
    if (isPremium(chatId)) {
      const reply = await askGrok(chatId, text);
      pushHistory(chatId, "assistant", reply);
      await tgSendMessage(chatId, reply);
      resetInactivityTimer(chatId);
      return;
    }

    // 2. Acabou de expirar
    if (justExpired) {
      awaitingPayment.set(chatId, true);
      await sendPlansMenu(
        chatId,
        "Aah amorzinho… 😌\nNosso tempinho acabou… mas eu tô louquinha pra continuar 💦\n\nEscolhe um pacotinho 👇"
      );
      resetInactivityTimer(chatId);
      return;
    }

    // 3. Aguardando pagamento → reenvia menu
    if (awaitingPayment.get(chatId)) {
      await sendPlansMenu(
        chatId,
        "Hmm… 😏 tô esperando você escolher um pacotinho aí embaixo…\nAssim que liberar eu me solto todinha 💦"
      );
      resetInactivityTimer(chatId);
      return;
    }

    // 4. Gate de ativação do pagamento
    const history = getHistory(chatId);
    const msgCount = userMsgCount.get(chatId) || 0;
    const lastMsgs = history.slice(-5).map(m => m.content.toLowerCase()).join(' ');
    const isPaymentTime = msgCount >= 10 && msgCount <= 14 &&
      /calorzinho|coxa|abraço|beijo|tesão|gostei|molhada|duro/.test(lastMsgs);

    if (isPaymentTime) {
      awaitingPayment.set(chatId, true);
      await sendPlansMenu(
        chatId,
        "Ai amor… 😳\nQuero MUITO continuar… mas pra eu ir sem freio preciso que você me libere 💦\n\nEscolhe um pacotinho 👇"
      );
      resetInactivityTimer(chatId);
      return;
    }

    // 5. Conversa normal (free tier)
    const reply = await askGrok(chatId, text);
    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
    resetInactivityTimer(chatId);

  } catch (e) {
    console.error("Erro no webhook:", e.message);
    await tgSendMessage(chatId, "Tive que sair um segundinho… mas já volto 😌");
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
