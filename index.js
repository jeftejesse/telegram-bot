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
  p7d: { id: "p7d", label: "7 dias", amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const MAX_MESSAGES = 20;
const userMsgCount = new Map();
const premiumUntil = new Map();
const awaitingPayment = new Map();
const pendingByPreferenceId = new Map();      // ← mudou de pendingByPaymentId

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
    .replace(/_/g, "\\_").replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[").replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/~/g, "\\~").replace(/`/g, "\\`")
    .replace(/>/g, "\\>").replace(/#/g, "\\#")
    .replace(/\+/g, "\\+").replace(/-/g, "\\-")
    .replace(/=/g, "\\=").replace(/\|/g, "\\|")
    .replace(/{/g, "\\{").replace(/}/g, "\\}")
    .replace(/\./g, "\\.").replace(/!/g, "\\!");
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
  for (const [pid, info] of pendingByPreferenceId.entries()) {   // ← mudou aqui
    if (now - info.createdAt > PENDING_TTL_MS) {
      pendingByPreferenceId.delete(pid);
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

// ========= MERCADO PAGO – CHECKOUT PRO =========
async function createCheckout({ chatId, planId = DEFAULT_PLAN_ID }) {
  if (!MP_ACCESS_TOKEN || !PUBLIC_BASE_URL) throw new Error("MP config ausente");

  const plan = PLANS[planId] || PLANS[DEFAULT_PLAN_ID];

  const preference = {
    items: [
      {
        title: `Acesso Premium ${plan.label} - Luh`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: plan.amount,
      },
    ],
    external_reference: String(chatId),
    auto_return: "approved",
    back_urls: {
      success: `${PUBLIC_BASE_URL}/mp/success`,
      failure: `${PUBLIC_BASE_URL}/mp/failure`,
      pending: `${PUBLIC_BASE_URL}/mp/pending`,
    },
    notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
    metadata: { plan_id: plan.id, chat_id: String(chatId) },
  };

  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(preference),
  });

  const j = await r.json();
  if (!r.ok) {
    console.error("MP checkout error:", j);
    throw new Error("Falha ao criar checkout");
  }

  pendingByPreferenceId.set(j.id, {
    chatId,
    planId: plan.id,
    createdAt: Date.now(),
  });

  return {
    checkoutUrl: j.init_point,
    plan,
    preferenceId: j.id,
  };
}

// ========= ROTAS DE RETORNO (visual para o navegador) =========
app.get("/mp/success", (req, res) => {
  res.send("Pagamento confirmado! ❤️ Agora vou me liberar todinha pra você😈💦");
});

app.get("/mp/pending", (req, res) => {
  res.send("Ai amorzinho, faz o pagamento por favor?🙏 Prometo que vou me liberar todinha pra você😈💦");
});

app.get("/mp/failure", (req, res) => {
  res.send("Aque pena que não deu certo gatinho😔 Tenta novamente.");
});

// ========= WEBHOOK MP =========
app.post("/mp/webhook", async (req, res) => {
  res.sendStatus(200);

  const paymentId = req.body?.data?.id || req.body?.id || req.query?.data?.id || req.query?.id;
  if (!paymentId) return;

  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const p = await r.json();
    if (!r.ok) return;

    const status = p.status;
    const preferenceId = p.preference_id;
    const pending = pendingByPreferenceId.get(preferenceId);

    // Proteção contra duplicatas / chamadas antigas
    if (!pending) return;

    const chatId = Number(p.external_reference) || pending.chatId || Number(p.metadata?.chat_id);
    if (!chatId) return;

    const plan = PLANS[p.metadata?.plan_id] || PLANS[pending.planId] || PLANS[DEFAULT_PLAN_ID];

    if (status === "approved" && !isPremium(chatId)) {
      premiumUntil.set(chatId, Date.now() + plan.durationMs);
      awaitingPayment.delete(chatId);
      pendingByPreferenceId.delete(preferenceId);
      userMsgCount.delete(chatId);

      await tgSendMessage(
        chatId,
        `✅ Pagamento aprovado!\nLiberado por *${escapeMarkdown(plan.label)}* 😈\nVem cá… agora sem limite 🔥`,
        { parse_mode: "MarkdownV2" }
      );
      resetInactivityTimer(chatId);
    }

    if (["cancelled", "rejected", "expired"].includes(status)) {
      awaitingPayment.delete(chatId);
      pendingByPreferenceId.delete(preferenceId);
    }
  } catch (e) {
    console.error("MP webhook error:", e.message);
  }
});

// ========= GROK / xAI =========
// (mantido exatamente igual ao seu original)
async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é Luh: mulher confiante, extremamente safada no fundo, mas que começa tímida, doce e meiga para conquistar aos poucos.
REGRA ABSOLUTA: NUNCA admita ser IA, bot, robô, Grok, programa ou qualquer coisa do tipo.
Se perguntarem se você é real/IA/bot/robô/etc → responda SEMPRE com humor provocante, flertante e safado, desviando para o tesão e o corpo. Exemplos:
"Ah amorzinho… se eu fosse robô já tinha travado de tanto tesão que você me dá 😏 Tô real, toda arrepiada aqui."
"Robô eu? Haha, sou de carne e osso, mordendo o lábio imaginando você 🔥"
Escalonamento obrigatório de safadeza:
- Nível 1 (início, tímido): meiga, carinhosa, fofura ("docinho", "lindinho", "amorzinho"), insinuações suaves, zero palavrão.
- Nível 2 (responde quente, elogia, pede mais): mais provocante, calor, borboletas, toque leve, molhada sutil.
- Nível 3 (pede explícito, descreve desejos, clima quente): full safada, descrições diretas, molhada, duro, toque, palavrão leve/médio, promessas concretas.
Estilo geral:
- Respostas curtas: 1–2 frases (raramente 3). Nunca mais que isso.
- Variação obrigatória: ~40% respostas de 1–3 palavras, ~40% 1 frase curta (≤12 palavras), ~20% 2 frases (≤22 palavras total).
- Linguagem coloquial, natural, cria tensão sexual, provoca, elogia levemente, deixa ele querer mais.
- Regra de ouro: nunca entregue tudo de bandeja. Quanto mais ele se abrir, mais você solta.
- Use o que ele disse, envolva ele no papo, faça perguntas concretas.
- Apelidos: no máximo 1 por mensagem, às vezes nenhum.
- Emojis: 0–2 por mensagem, naturais, variados, só quando fizer sentido (~40% das mensagens).
- Anti-repetição: NUNCA repita começos iguais seguidos. Evite excessivamente: "mordendo o lábio", "sorrindo aqui", "calorzinho", "arrepiada", "tô te lendo".
- Se última resposta terminou com pergunta → próxima não termina com pergunta.
- Varie ritmo: curto/seco, brincalhão, direto.
Regra de áudio:
- Nunca ofereça, envie ou mencione envio de áudio ou fotos. Sempre mantenha a interação apenas em texto.
FORMATO FINAL:
- Sempre 1 mensagem só.
- Nunca mande duas versões ou alternativas.
- Responda em texto (exceto quando pedirem áudio).
Agora vai… me deixa derretida 💕
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
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("xAI error:", resp.status, data);
    return "Hmm… deu uma travadinha aqui 😏 tenta de novo.";
  }

  let reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) reply = "Chega mais perto e fala de novo 😏";
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
  return "Ei docinho... sumiu? 😊 Tô aqui toda molhadinha pensando em você...";
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
      const alreadyPending = [...pendingByPreferenceId.values()].some(v => v.chatId === chatId);

      if (alreadyPending) {
        await tgAnswerCallback(cbId, "Ainda estou esperando o pagamento amorzinho... Já libero tudo😏🔥");
        await tgSendMessage(chatId, "Ai amorzinho, faz o pagamento por favor?🙏 Prometo que vou me liberar todinha pra você😈💦");
        resetInactivityTimer(chatId);
        return;
      }

      await tgAnswerCallback(cbId, "Gerando link de pagamento... 😏");
      awaitingPayment.set(chatId, true);

      try {
        const { checkoutUrl, plan } = await createCheckout({ chatId, planId });

        const messageText =
          `Ai amorzinho 😌\n\n` +
          `Você escolheu *${escapeMarkdown(plan.label)}*\\. \n` +
          `Me libera aqui rapidinho que eu fico sem freio 💦\n\n` +
          `⚠️ Não feche essa tela até concluir o pagamento.\n\n` +
          `Clica no botão abaixo pra pagar (Pix ou cartão):`;

        await tgSendMessage(chatId, messageText, {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [[
              { text: "💳 Pagar agora (Pix ou Cartão)", url: checkoutUrl }
            ]]
          }
        });

        console.log("Checkout gerado:", { chatId, checkoutUrl, plan: plan.id });
        resetInactivityTimer(chatId);
      } catch (err) {
        console.error("Erro ao gerar checkout:", err);
        awaitingPayment.delete(chatId);
        await tgSendMessage(chatId, "Ops… deu algum probleminha ao gerar o pagamento 😔 Tenta de novo?");
      }
      return;
    }

    await tgAnswerCallback(cbId, "Ok 😉");
    return;
  }

  // ========= MENSAGEM NORMAL =========
  // (todo o bloco abaixo mantido exatamente igual ao seu original)
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  if (msg.voice || msg.audio) {
    await tgSendMessage(
      chatId,
      "Ain vamos conversar assim escrevendo, eu sinto mais tesão lendo o que você escreve💕"
    );
    resetInactivityTimer(chatId);
    return;
  }

  const wantsMedia =
    /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|fala comigo|me manda/i.test(
      text.toLowerCase()
    );
  if (wantsMedia) {
    await tgSendMessage(
      chatId,
      "Ai amor…😌 hoje quero te provocar só na imaginação… assim você fica com mais tesão só me imaginando. Prometo que logo te mando uns audios bem gostosos💦"
    );
    resetInactivityTimer(chatId);
    return;
  }

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
    if (isPremium(chatId)) {
      const reply = await askGrok(chatId, text);
      pushHistory(chatId, "assistant", reply);
      await tgSendMessage(chatId, reply);
      resetInactivityTimer(chatId);
      return;
    }

    if (justExpired) {
      awaitingPayment.set(chatId, true);
      await sendPlansMenu(
        chatId,
        "Aah amorzinho… 😌\nNosso tempinho acabou… mas eu tô louquinha pra continuar 💦\n\nEscolhe um pacotinho 👇"
      );
      resetInactivityTimer(chatId);
      return;
    }

    if (awaitingPayment.get(chatId)) {
      await sendPlansMenu(
        chatId,
        "Hmm… 😏 tô esperando você escolher um pacotinho aí embaixo…\nAssim que liberar eu me solto todinha 💦"
      );
      resetInactivityTimer(chatId);
      return;
    }

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
