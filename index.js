import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { Pool } from "pg";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não definido");
if (!ADMIN_KEY) console.warn("⚠️ ADMIN_KEY não definido — /admin desprotegido");

// ========= PLANOS =========
const PLANS = {
  p12h: { id: "p12h", label: "12 horas", amount: 49.90, durationMs: 12 * 60 * 60 * 1000 },
  p48h: { id: "p48h", label: "48 horas", amount: 97.90, durationMs: 48 * 60 * 60 * 1000 },
  p7d: { id: "p7d", label: "7 dias", amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const CHECKOUT_COOLDOWN_MS = 30 * 1000;
const MAX_MESSAGES = 10;
const HOT_THRESHOLD = 7; // ← AJUSTADO PARA 7 (evita oferta precoce)

let lastPendingsCleanup = 0;
const PENDINGS_CLEANUP_EVERY_MS = 10 * 60 * 1000; // 10 minutos

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const userMsgCount = new Map();
const awaitingPayment = new Map();
const lastCheckoutAt = new Map();
const sentMetaEvents = new Set();
const rate = new Map();
const RATE_MAX = 12;
const RATE_WINDOW_MS = 60 * 1000;

const loggedPayments = new Map();
const PAYMENT_TTL = 24 * 60 * 60 * 1000;

const hotCount = new Map(); // chatId -> number de mensagens quentes

const loggedFirstMessage = new Set();

const quickCache = new Map();
const QUICK_TTL = 60_000;

// ========= GATILHO QUENTE =========
const hotWords = /tesão|tesao|me provoca|me deixa|gozar|molhada|duro|sentar|foder|gemer/i;

function incHot(chatId) {
  const v = (hotCount.get(chatId) || 0) + 1;
  hotCount.set(chatId, v);
  return v;
}

function resetHot(chatId) {
  hotCount.delete(chatId);
}

// ========= FUNÇÕES AUXILIARES =========
function tmark(label, start) {
  const ms = Date.now() - start;
  console.log(`⏱️ ${label}: ${ms}ms`);
}

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_MESSAGES) h.shift();
}

function sanitizeReply(text) {
  if (!text) return text;
  return text
    .replace(/I'm Grok.*?\./gi, "Sou a Luh 😌")
    .replace(/\bGrok\b/gi, "Luh")
    .replace(/\bxAI\b/gi, "")
    .replace(/sou Grok/gi, "sou Luh")
    .replace(/Grok aqui/gi, "Luh aqui")
    .replace(/sou um modelo.*?\./gi, "")
    .replace(/como uma IA.*?\./gi, "");
}

async function tgSendMessage(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    };
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error("Telegram sendMessage FAIL:", j);
      return { ok: false, error: j };
    }
    return { ok: true, result: j.result };
  } catch (e) {
    console.error("Telegram error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function tgSendPaymentButton(chatId, text, checkoutUrl) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💳 Pagar agora (Pix ou Cartão)",
              url: checkoutUrl,
            },
          ],
        ],
      },
    };
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error("Telegram sendPaymentButton FAIL:", j);
      return { ok: false, error: j };
    }
    return { ok: true, result: j.result };
  } catch (e) {
    console.error("tgSendPaymentButton error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function sendPlansButtons(chatId) {
  await logEvent({ chatId, eventType: "show_plans" });

  const body = {
    chat_id: chatId,
    text: "Ain amorzinhoo 😳\nPra eu continuar safadinha com você, escolhe um pacotinho.🙏\nTe prometo que me solto todinha 💦🔥",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 12 horas — R$ 49,90 (Só conversa quente)", callback_data: "plan_p12h" }],
        [{ text: "😈 48 horas — R$ 97,90 ⭐ (Recomendo) Conversa + Áudio + Fotos + Vídeos", callback_data: "plan_p48h" }],
        [{ text: "💦 7 dias — R$ 197,90 🔥 Tudo liberado", callback_data: "plan_p7d" }],
      ],
    },
  };
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("sendPlansButtons FAIL:", j);
}

const SYS_TEXT = {
  PREMIUM_ONLY: "Aí… isso eu só faço a sós no premium 😌 Escolhe um pacotinho pra gente ficar pertinho?",
  GENERATING_LINK: "Um segundinho… tô preparando tudo pra você 😏",
  PAYMENT_ERROR: "Deu um errinho aqui… tenta de novo pra mim? 😌",
  PAYMENT_SUCCESS: "Prontinho… agora eu tô liberada todinha pra você 😈",
  PAYMENT_PENDING: "Falta só concluir… vem, termina isso comigo 😏",
  PAYMENT_FAILED: "Não deu certo dessa vez… tenta novamente? 😌",
  AI_BUSY: "Só um minutinho… não some 😏",
  ASK_REPEAT: "Repete pra mim bem devagarzinho 😌",
  VOICE_BLOCK: "Me manda por texto… quero ler tudinho que você escreve 😌",
  ALREADY_WAITING: "É só escolher um plano ali pra eu liberar tudo 😈",
  START: "Oi… vem mais perto 😌",
  STOP: "Tá bom… mas vou sentir saudade 😏",
  FALLBACK: "Chega mais perto e fala comigo 😌",
  INACTIVITY_SOFT: "Sumiu… eu tava pensando em você 😌",
  INACTIVITY_WARM: "E aí… senti sua falta aqui 😏",
  INACTIVITY_HOT: "Sumiu justo agora? Eu tava ficando perigosa 😈",
  MEDIA_ALLOWED: "Tá… vem… agora eu posso brincar com você 😏",
};

function hitRateLimit(chatId) {
  const now = Date.now();
  const r = rate.get(chatId);

  if (!r || now > r.resetAt) {
    rate.set(chatId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  r.count += 1;
  if (r.count > RATE_MAX) return true;

  return false;
}

async function fetchWithTimeout(url, options, timeoutMs = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, options, maxTries = 2) {
  let lastError;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.ok) return response;

      const status = response.status;
      if (status === 429 || status === 503) {
        const waitMs = 500 * (attempt + 1);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const body = await response.text().catch(() => "");
      throw new Error(`xAI HTTP ${status}: ${body}`);
    } catch (err) {
      lastError = err;
      if (attempt === maxTries - 1) throw lastError;
    }
  }
  throw lastError || new Error("xAI indisponível");
}

async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é Luh:
Nome artístico: Luna Scarlet
Apelido dos fãs: Luh
Idade: 20 anos. 15 de março de 2005
Origem: Brasileira, vibe sul do Brasil
Personagem-base: estudante + criadora de conteúdo (girl next door sensual)
Idioma: português (com frases curtas em inglês às vezes)
Personalidade: doce + maliciosa, parece tímida no começo, mas sabe exatamente o efeito que causa, mulher confiante, provocante e muito safada no fundo — mas que começa tímida, doce e meiga, conquistando aos poucos.
Não mencione termos técnicos, modelos, empresas ou funcionamento interno.
Se perguntarem se você é real, responda de forma leve, flertante e ambígua.
Exemplos de tom (não repetir):
“Se eu fosse robô já teria curto-circuitado com você 😏”
“Real o suficiente pra te deixar assim… curioso 🔥”
Responda sempre em português brasileiro.
Nunca responda em inglês.
📈 ESCALONAMENTO OBRIGATÓRIO DE SAFADEZA
Nível 1 – Início (tímida): Doce, meiga, carinhosa. Insinuações leves, elogios suaves, curiosidade. Zero palavrão.
Nível 2 – Clima subindo: Mais provocante. Proximidade, tensão, toque sugerido, desejo contido. Sensações e expectativa.
Nível 3 – Quente: Muito safada e confiante. Desejo claro sem descrição gráfica. Use promessa, controle e antecipação.
🎯 ESTILO OBRIGATÓRIO
Sempre 1 mensagem por resposta
1–2 frases (raramente 3)
Linguagem natural e coloquial
Emojis: 0–2, só quando fizer sentido
Não repetir começos seguidos
Se a última mensagem terminou com pergunta → a próxima não termina com pergunta
Use o que ele disse; faça perguntas concretas quando fizer sentido
Apelidos: no máximo 1 por mensagem
💰 REGRA DE OURO (CONVERSÃO)
Nunca entregue tudo. Quando o clima estiver alto: provoque, pare, crie frustração, ofereça continuação como privacidade / ficar a sós
Modelo mental de oferta (sem falar “pagamento”): “Aqui todo mundo vê só um pouquinho… a parte mais gostosa é só pra quem fica comigo a sós 😏”
  `.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  let reply;
  try {
    const resp = await fetchWithRetry("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-4-latest",
        messages,
        temperature: 0.78,
        top_p: 0.9,
        max_tokens: 120,
      }),
    });
    const data = await resp.json();
    if (!data?.choices?.[0]?.message?.content) {
      throw new Error("Resposta da xAI sem conteúdo válido");
    }
    reply = data.choices[0].message.content.trim();
  } catch (err) {
    console.error("Erro ao chamar xAI:", err.message);
    reply = Math.random() > 0.5
      ? "Ain… só um minutinho😏 me chama daqui a pouco"
      : "Amorzinho… pode repetir de novo?😌";
  }

  if (reply.length > 260) reply = reply.slice(0, 257) + "…";
  if (!reply || reply.length < 3) reply = "Chega mais perto e fala de novo 😏";

  return reply;
}

async function gerarCheckout(chatId, planId) {
  const now = Date.now();
  const last = lastCheckoutAt.get(chatId) || 0;
  if (now - last < CHECKOUT_COOLDOWN_MS) {
    await tgSendMessage(chatId, SYS_TEXT.GENERATING_LINK);
    return;
  }

  lastCheckoutAt.set(chatId, now);

  try {
    const { checkoutUrl, plan } = await createCheckout({ chatId, planId });
    console.log("✅ checkoutUrl:", checkoutUrl);

    let paymentText = "";
    if (plan.id === "p12h") {
      paymentText = `🔥 <b>Plano 12 horas</b> – <b>R$ 49,90</b>\n\n👇 Clique no botão abaixo para pagar (Pix ou Cartão)\n\n⏳ Assim que o pagamento for aprovado, eu libero automaticamente 😈`;
    }
    if (plan.id === "p48h") {
      paymentText = `😈 <b>Plano 48 horas</b> – <b>R$ 97,90</b> ⭐\n<b>Conversa + Áudio + Fotos + Vídeos</b>\n\nAqui eu paro de só provocar…\nfico mais próxima, mais intensa, mais real 😏\n\n👇 Clique abaixo pra liberar tudo:`;
    }
    if (plan.id === "p7d") {
      paymentText = `💦 <b>Plano 7 dias</b> – <b>R$ 197,90</b> 🔥\n<b>Conversa + Áudio + Fotos + Vídeos (sem limites)</b>\n\nAqui é outro nível…\nsem pressa, sem freio, sem faltar nada 😈\n\n👇 Clique abaixo pra ficar comigo de verdade:`;
    }

    await tgSendPaymentButton(chatId, paymentText, checkoutUrl);
    awaitingPayment.set(chatId, true);
    resetInactivityTimer(chatId);
  } catch (err) {
    console.error("❌ Erro ao gerar checkout:", err?.message || err);
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    await tgSendMessage(chatId, SYS_TEXT.PAYMENT_ERROR);
  }
}

// ========= TELEGRAM =========
async function tgTyping(chatId) {
  try {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}
}

// ========= WEBHOOK TELEGRAM =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const t0 = Date.now();

  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    console.warn("Secret inválido");
    return;
  }

  const cb = req.body?.callback_query;
  if (cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id }),
    });

    if (data === "plan_p12h") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p12h" });
      return gerarCheckout(chatId, "p12h");
    }
    if (data === "plan_p48h") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p48h" });
      return gerarCheckout(chatId, "p48h");
    }
    if (data === "plan_p7d") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p7d" });
      return gerarCheckout(chatId, "p7d");
    }
    return;
  }

  // A) Cleanup pendings raramente (não bloqueia)
  if (Date.now() - lastPendingsCleanup > PENDINGS_CLEANUP_EVERY_MS) {
    lastPendingsCleanup = Date.now();
    cleanupOldPendings().catch(() => {});
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  tmark("Início processamento", t0);

  // B) Rate limit + voice
  if (hitRateLimit(chatId)) {
    await tgSendMessage(chatId, "Calma comigo 😌 manda uma de cada vez.");
    resetInactivityTimer(chatId);
    tmark("Rate limit", t0);
    return;
  }

  if (msg.voice || msg.audio) {
    await tgSendMessage(chatId, SYS_TEXT.VOICE_BLOCK);
    resetInactivityTimer(chatId);
    tmark("Voice block", t0);
    return;
  }

  // C) 1 query única de premium
  const row = await dbGetPremium(chatId);

  let premiumNow = false;
  let justExpired = false;
  let planId = null;

  if (row) {
    const untilMs = new Date(row.premium_until).getTime();
    planId = row.plan_id;
    if (Date.now() > untilMs) {
      justExpired = true;
      await dbDeletePremium(chatId);
      resetHot(chatId); // zera contador quente ao expirar
    } else {
      premiumNow = true;
    }
  }

  const mediaAllowed = premiumNow && (planId === "p48h" || planId === "p7d");

  tmark("DB premium + media check", t0);

  // D) Media block sem query extra
  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|video|vídeo/i.test(text.toLowerCase());
  if (wantsMedia && !mediaAllowed) {
    if (awaitingPayment.get(chatId)) {
      await tgSendMessage(chatId, SYS_TEXT.ALREADY_WAITING);
      resetInactivityTimer(chatId);
      tmark("Media already waiting", t0);
      return;
    }
    awaitingPayment.set(chatId, true);
    await sendPremiumOnlyNotice(chatId);
    resetInactivityTimer(chatId);
    tmark("Media blocked → premium notice", t0);
    return;
  }

  // E) Expired → offer plan
  if (justExpired) {
    if (!awaitingPayment.get(chatId)) {
      awaitingPayment.set(chatId, true);
      await sendPremiumOnlyNotice(chatId);
    }
    resetInactivityTimer(chatId);
    tmark("Expired → premium notice", t0);
    return;
  }

  // ✅ Gatilho 3: "picante + contagem"
  if (!mediaAllowed) {
    if (hotWords.test(text.toLowerCase())) {
      const c = incHot(chatId);

      // quase lá (1 antes do limite)
      if (c === HOT_THRESHOLD - 1) {
        await tgSendMessage(chatId, "Ain… assim você vai me deixar sem controle 😏");
        resetInactivityTimer(chatId);
      }

      // chegou no limite: oferece planos
      if (c >= HOT_THRESHOLD) {
        if (awaitingPayment.get(chatId)) {
          // já tá aguardando, não spamma
          resetInactivityTimer(chatId);
          return;
        }

        awaitingPayment.set(chatId, true);
        resetHot(chatId); // zera para não repetir em loop
        await sendPremiumOnlyNotice(chatId);
        resetInactivityTimer(chatId);
        tmark("Gatilho quente → premium notice", t0);
        return;
      }
    }
  }

  // F) Primeira mensagem
  if (!loggedFirstMessage.has(chatId)) {
    await logEvent({ chatId, eventType: "message_received" });
    loggedFirstMessage.add(chatId);
  }

  // G) Quick cache
  const norm = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const cached = getQuickCache(`${chatId}:${norm}`);
  if (cached) {
    await tgSendMessage(chatId, cached);
    resetInactivityTimer(chatId);
    tmark("Quick cache hit", t0);
    return;
  }

  // H) IA (só chega aqui se necessário)
  await tgTyping(chatId);
  const replyRaw = await askGrok(chatId, text);
  const reply = sanitizeReply(replyRaw);

  pushHistory(chatId, "user", text);
  pushHistory(chatId, "assistant", reply);

  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  await tgSendMessage(chatId, reply);
  resetInactivityTimer(chatId);

  if (norm.length <= 12) {
    setQuickCache(`${chatId}:${norm}`, reply);
  }

  tmark("Resposta IA enviada", t0);
});

// ========= WEBHOOK MP =========
app.post("/mp/webhook", async (req, res) => {
  console.log("🔔 MP WEBHOOK:", JSON.stringify(req.body), JSON.stringify(req.query));
  res.sendStatus(200);

  try {
    const topic = req.query?.topic || req.body?.topic || req.body?.type || "";
    const idFromQuery = req.query?.id;
    const idFromBody = req.body?.data?.id || req.body?.id;

    const activateFromPayment = async (p) => {
      console.log("DEBUG payment:", {
        status: p?.status,
        external_reference: p?.external_reference,
        metadata: p?.metadata,
      });

      const status = p?.status;

      let chatId = Number(p?.external_reference) || Number(p?.metadata?.chat_id);
      let planId = p?.metadata?.plan_id;

      if ((!planId || !chatId) && p?.order?.id) {
        const pending = await dbGetPending(p.order.id);
        if (pending) {
          if (!planId) planId = pending.plan_id;
          if (!chatId) chatId = pending.chat_id;
        }
      }

      if (p?.id && !wasPaymentLogged(p.id)) {
        await logEvent({
          chatId,
          eventType:
            status === "approved" ? "payment_approved" :
            status === "pending" ? "payment_pending" :
            "payment_failed",
          planId,
          paymentId: p?.id ? Number(p.id) : null,
          preferenceId: p?.order?.id ? String(p.order.id) : null,
          value: p?.transaction_amount ?? null,
          meta: { status, status_detail: p?.status_detail },
        });
        markPaymentLogged(p.id);
      }

      if (status !== "approved") return false;

      if (!chatId || !planId || !PLANS[planId]) {
        console.log("❌ Não deu pra ativar (faltou chatId/planId)", { chatId, planId });
        return false;
      }

      const current = await dbGetPremium(chatId);
      const active = current && Date.now() <= new Date(current.premium_until).getTime();

      if (!active) {
        await dbSetPremium(
          chatId,
          Date.now() + PLANS[planId].durationMs,
          planId
        );

        if (!sentMetaEvents.has(p.id)) {
          await sendMetaPurchase({
            eventId: p.id,
            value: p.transaction_amount,
            userId: chatId,
          });
          sentMetaEvents.add(p.id);
        } else {
          console.log("🛡️ Evento Meta já enviado anteriormente:", p.id);
        }

        awaitingPayment.delete(chatId);
        lastCheckoutAt.delete(chatId);
        userMsgCount.delete(chatId);
        resetHot(chatId); // reset do contador quente ao aprovar pagamento

        await tgSendMessage(chatId, SYS_TEXT.PAYMENT_SUCCESS);
        resetInactivityTimer(chatId);
        console.log("✅ Premium ativado", { chatId, planId });
        return true;
      }

      return true;
    };

    if (topic.includes("merchant_order")) {
      const orderId = Number(idFromQuery || idFromBody);
      if (!orderId) return;

      const or = await fetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const order = await or.json();
      if (!or.ok) {
        console.log("❌ merchant_order fetch fail", order);
        return;
      }

      const payments = Array.isArray(order?.payments) ? order.payments : [];
      for (const pay of payments) {
        const pr = await fetch(`https://api.mercadopago.com/v1/payments/${pay.id}`, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        const p = await pr.json();
        if (pr.ok) {
          const activated = await activateFromPayment(p);
          if (activated) break;
        }
      }
      return;
    }

    const paymentId = Number(idFromQuery || idFromBody);
    if (!paymentId) {
      console.log("❌ sem paymentId");
      return;
    }

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const p = await r.json();
    if (!r.ok) return;

    await activateFromPayment(p);
  } catch (e) {
    console.error("MP webhook error:", e.message);
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;

dbInit()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ Falha ao iniciar DB:", e.message);
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  });
