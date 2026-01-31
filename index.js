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
const HOT_THRESHOLD = 7;
let lastPendingsCleanup = 0;
const PENDINGS_CLEANUP_EVERY_MS = 10 * 60 * 1000;
const CHECKOUT_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutos para expirar awaitingPayment

// ========= PAYMENT DEDUPE (fallback sem DB) =========
const paymentDedupeRam = new Map();
const PAYMENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupPaymentDedupeRam() {
  const now = Date.now();
  for (const [id, expiresAt] of paymentDedupeRam.entries()) {
    if (expiresAt <= now) paymentDedupeRam.delete(id);
  }
}

function markPaymentLoggedRAM(paymentId) {
  const now = Date.now();
  const expiresAt = paymentDedupeRam.get(paymentId);
  if (expiresAt && expiresAt > now) return false;
  paymentDedupeRam.set(paymentId, now + PAYMENT_DEDUPE_TTL_MS);
  return true;
}

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const userMsgCount = new Map();
const awaitingPayment = new Map();
const lastCheckoutAt = new Map();
const sentMetaEvents = new Set();
const rate = new Map();
const RATE_MAX = 12;
const RATE_WINDOW_MS = 60 * 1000;
const loggedFirstMessage = new Set();
const quickCache = new Map();
const QUICK_TTL = 60_000;
const hotCount = new Map();

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

// ========= DEBUG TIMER =========
function tmark(label, start) {
  const ms = Date.now() - start;
  console.log(`⏱️ ${label}: ${ms}ms`);
}

// ========= QUICK CACHE =========
const GENERIC_WORDS = new Set([
  "oi", "oii", "oiii", "olá", "ola", "bom dia", "boa tarde", "boa noite", "hey", "eai", "e aí", "eaii",
]);

function shouldUseQuickCache(normText) {
  if (!normText) return false;
  if (normText.length <= 4) return false;
  if (GENERIC_WORDS.has(normText)) return false;
  return true;
}

function getQuickCache(key) {
  const v = quickCache.get(key);
  if (!v) return null;
  if (Date.now() - v.time > QUICK_TTL) {
    quickCache.delete(key);
    return null;
  }
  return v.text;
}

function setQuickCache(key, text) {
  quickCache.set(key, { text, time: Date.now() });
}

// ========= DB =========
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function dbInit() {
  if (!pool) {
    console.log("⚠️ Sem DATABASE_URL, iniciando sem DB");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premiums (
      chat_id BIGINT PRIMARY KEY,
      premium_until TIMESTAMPTZ NOT NULL,
      plan_id TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pendings (
      preference_id TEXT PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      plan_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversion_events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      plan_id TEXT,
      preference_id TEXT,
      payment_id BIGINT,
      value NUMERIC,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_dedupe (
      payment_id BIGINT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ DB pronto");
}

async function markPaymentLoggedDB(paymentId) {
  if (!pool) return false;
  const r = await pool.query(
    `INSERT INTO payment_dedupe (payment_id) VALUES ($1)
     ON CONFLICT DO NOTHING
     RETURNING payment_id`,
    [paymentId]
  );
  return r.rowCount > 0;
}

async function dbCleanupOldPaymentDedupe(days = 30) {
  if (!pool) return;
  await pool.query(`DELETE FROM payment_dedupe WHERE created_at < NOW() - ($1::text)::interval`, [
    `${days} days`,
  ]);
}

async function dbGetPremium(chatId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT premium_until, plan_id FROM premiums WHERE chat_id = $1`, [chatId]);
  return r.rowCount ? r.rows[0] : null;
}

async function dbSetPremium(chatId, untilMs, planId) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO premiums (chat_id, premium_until, plan_id)
    VALUES ($1, to_timestamp($2 / 1000.0), $3)
    ON CONFLICT (chat_id) DO UPDATE
      SET premium_until = EXCLUDED.premium_until,
          plan_id = EXCLUDED.plan_id
    `,
    [chatId, untilMs, planId]
  );
}

async function dbDeletePremium(chatId) {
  if (!pool) return;
  await pool.query(`DELETE FROM premiums WHERE chat_id = $1`, [chatId]);
}

async function dbInsertPending(preferenceId, chatId, planId) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO pendings (preference_id, chat_id, plan_id, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (preference_id) DO UPDATE
      SET chat_id = EXCLUDED.chat_id,
          plan_id = EXCLUDED.plan_id,
          created_at = NOW()
    `,
    [preferenceId, chatId, planId]
  );
}

async function dbGetPending(preferenceId) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT preference_id, chat_id, plan_id, created_at FROM pendings WHERE preference_id = $1`,
    [preferenceId]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function dbCleanupOldPendings(ttlMs) {
  if (!pool) return;
  await pool.query(
    `DELETE FROM pendings WHERE created_at < NOW() - ($1::text)::interval`,
    [`${Math.floor(ttlMs / 1000)} seconds`]
  );
}

async function cleanupOldPendings() {
  await dbCleanupOldPendings(PENDING_TTL_MS);
  await dbCleanupOldPaymentDedupe(30);
  cleanupPaymentDedupeRam();
}

// ========= FUNÇÕES DE LOG =========
async function logEvent({
  chatId,
  eventType,
  planId = null,
  preferenceId = null,
  paymentId = null,
  value = null,
  meta = null,
}) {
  if (!pool || !chatId) return;
  pool.query(
    `
    INSERT INTO conversion_events
    (chat_id, event_type, plan_id, preference_id, payment_id, value, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [chatId, eventType, planId, preferenceId, paymentId, value, meta ? JSON.stringify(meta) : null]
  ).catch((e) => console.error("logEvent error:", e.message));
}

// ========= ADMIN PROTECTION =========
app.use("/admin", (req, res, next) => {
  const key = req.get("x-admin-key");
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).send("Acesso negado");
  next();
});

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
    const body = { chat_id: chatId, text, disable_web_page_preview: true, ...extra };
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
        inline_keyboard: [[{ text: "💳 Pagar agora (Pix ou Cartão)", url: checkoutUrl }]],
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

function tgTyping(chatId) {
  fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
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

async function sendPlansButtons(chatId) {
  logEvent({ chatId, eventType: "show_plans" }).catch(() => {});
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

async function sendPremiumOnlyNotice(chatId) {
  await tgSendMessage(chatId, SYS_TEXT.PREMIUM_ONLY);
  await sendPlansButtons(chatId);
}

// ========= RATE LIMIT =========
function hitRateLimit(chatId) {
  const now = Date.now();
  const r = rate.get(chatId);
  if (!r || now > r.resetAt) {
    rate.set(chatId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  r.count += 1;
  return r.count > RATE_MAX;
}

// ========= HTTP HELPERS =========
async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, options) {
  return fetchWithTimeout(url, options);
}

// ========= xAI / GROK =========
async function askGrok(chatId, userText, isPremium) {
  const systemPrompt = `
Você é Luh: mulher confiante, provocante e muito safada no fundo — mas que começa tímida, doce e meiga, conquistando aos poucos.
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

  const history = isPremium ? getHistory(chatId) : [];

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
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
        model: "grok-beta",
        messages,
        temperature: 0.7,
        top_p: 0.85,
        max_tokens: 70,
      }),
    });
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Resposta sem conteúdo válido");
    reply = String(content).trim();
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn("⚠️ xAI demorou demais, usando fallback");
    } else {
      console.error("Erro ao chamar xAI:", err?.message || err);
    }
    reply = Math.random() > 0.5
      ? "Ain… cheguei agora 😌 fala comigo de novo"
      : "Amorzinho… pode repetir de novo?😌";
  }

  if (reply.length > 260) reply = reply.slice(0, 257) + "…";
  if (!reply || reply.length < 3) reply = "Chega mais perto e fala de novo 😏";
  return reply;
}

// ========= META CONVERSIONS API =========
async function sendMetaPurchase({ eventId, value, userId }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;
  try {
    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id: String(eventId),
          action_source: "website",
          user_data: {
            external_id: crypto.createHash("sha256").update(String(userId)).digest("hex"),
          },
          custom_data: {
            currency: "BRL",
            value: Number(value) || 0,
          },
        },
      ],
    };
    const url = `https://graph.facebook.com/v18.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j?.events_received === 1) console.log("✅ Meta Purchase enviado com sucesso:", eventId);
    else console.log("⚠️ Meta resposta:", j);
  } catch (e) {
    console.error("❌ Meta CAPI error:", e.message);
  }
}

// ========= MERCADO PAGO – CHECKOUT PRO =========
async function createCheckout({ chatId, planId = DEFAULT_PLAN_ID }) {
  if (!MP_ACCESS_TOKEN || !PUBLIC_BASE_URL) throw new Error("MP config ausente");
  const plan = PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
  const preference = {
    items: [
      {
        title: `Acesso Premium ${plan.label}`,
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
  await dbInsertPending(j.id, chatId, plan.id);
  logEvent({
    chatId,
    eventType: "checkout_created",
    planId: plan.id,
    preferenceId: j.id,
    value: plan.amount,
  }).catch(() => {});
  return {
    checkoutUrl: j.init_point,
    plan,
    preferenceId: j.id,
  };
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
  } catch (err) {
    console.error("❌ Erro ao gerar checkout:", err?.message || err);
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    await tgSendMessage(chatId, SYS_TEXT.PAYMENT_ERROR);
  }
}

// ========= WEBHOOK TELEGRAM =========
app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    console.warn("Secret inválido");
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const t0 = Date.now();
  const cb = req.body?.callback_query;
  if (cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;
    fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id }),
    }).catch(() => {});
    if (data === "plan_p12h") {
      logEvent({ chatId, eventType: "click_plan", planId: "p12h" }).catch(() => {});
      return gerarCheckout(chatId, "p12h");
    }
    if (data === "plan_p48h") {
      logEvent({ chatId, eventType: "click_plan", planId: "p48h" }).catch(() => {});
      return gerarCheckout(chatId, "p48h");
    }
    if (data === "plan_p7d") {
      logEvent({ chatId, eventType: "click_plan", planId: "p7d" }).catch(() => {});
      return gerarCheckout(chatId, "p7d");
    }
    return;
  }

  if (Date.now() - lastPendingsCleanup > PENDINGS_CLEANUP_EVERY_MS) {
    lastPendingsCleanup = Date.now();
    cleanupOldPendings().catch(() => {});
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text && !msg.voice && !msg.audio) return;

  tmark("Início processamento", t0);

  if (hitRateLimit(chatId)) {
    await tgSendMessage(chatId, "Calma comigo 😌 manda uma de cada vez.");
    tmark("Rate limit", t0);
    return;
  }

  // Tratamento de voz/áudio: vira gatilho de premium se não tiver
  if (msg.voice || msg.audio) {
    const row = await dbGetPremium(chatId);
    const premiumNow = row && Date.now() <= new Date(row.premium_until).getTime();
    if (!premiumNow) {
      awaitingPayment.set(chatId, true);
      await sendPremiumOnlyNotice(chatId);
      tmark("Voice/Audio → premium notice", t0);
      return;
    }
    // Se premium, continua normalmente (pode responder depois)
  }

  tgTyping(chatId);

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
      resetHot(chatId);
      memory.delete(chatId); // Limpa histórico ao expirar
    } else {
      premiumNow = true;
    }
  }

  const mediaAllowed = premiumNow && (planId === "p48h" || planId === "p7d");

  // Expira awaitingPayment se passou muito tempo sem pagar
  if (!premiumNow && awaitingPayment.get(chatId)) {
    const last = lastCheckoutAt.get(chatId) || 0;
    if (Date.now() - last > CHECKOUT_EXPIRATION_MS) {
      awaitingPayment.delete(chatId);
      lastCheckoutAt.delete(chatId);
    }
  }

  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|video|vídeo/i.test((text || "").toLowerCase());

  if (wantsMedia && !mediaAllowed) {
    if (awaitingPayment.get(chatId)) {
      await tgSendMessage(chatId, SYS_TEXT.ALREADY_WAITING);
      tmark("Media already waiting", t0);
      return;
    }
    awaitingPayment.set(chatId, true);
    await sendPremiumOnlyNotice(chatId);
    tmark("Media blocked → premium notice", t0);
    return;
  }

  if (justExpired) {
    if (!awaitingPayment.get(chatId)) {
      awaitingPayment.set(chatId, true);
      await sendPremiumOnlyNotice(chatId);
    }
    tmark("Expired → premium notice", t0);
    return;
  }

  // Gatilho quente só se NÃO tiver mídia liberada e NÃO for premium
  if (!mediaAllowed && !premiumNow) {
    if (hotWords.test((text || "").toLowerCase())) {
      const c = incHot(chatId);
      if (c === HOT_THRESHOLD - 1) {
        await tgSendMessage(chatId, "Ain… assim você vai me deixar sem controle 😏");
      }
      if (c >= HOT_THRESHOLD) {
        if (awaitingPayment.get(chatId)) return;
        awaitingPayment.set(chatId, true);
        resetHot(chatId);
        await sendPremiumOnlyNotice(chatId);
        tmark("Gatilho quente → premium notice", t0);
        return;
      }
    }
  }

  if (!loggedFirstMessage.has(chatId)) {
    logEvent({ chatId, eventType: "message_received" }).catch(() => {});
    loggedFirstMessage.add(chatId);
  }

  if (!text) {
    // Se for só voz/áudio e premium, pode responder algo genérico ou pular
    await tgSendMessage(chatId, "Tá me deixando curiosa… me conta por texto o que você quer 😏");
    return;
  }

  const norm = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const cacheKey = `${chatId}:${norm}`;
  if (shouldUseQuickCache(norm)) {
    const cached = getQuickCache(cacheKey);
    if (cached) {
      await tgSendMessage(chatId, cached);
      tmark("Quick cache hit", t0);
      return;
    }
  }

  const replyRaw = await askGrok(chatId, text, premiumNow);
  const reply = sanitizeReply(replyRaw);

  pushHistory(chatId, "user", text);
  if (premiumNow) pushHistory(chatId, "assistant", reply);

  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  await tgSendMessage(chatId, reply);

  if (shouldUseQuickCache(norm)) setQuickCache(cacheKey, reply);

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
      const payId = Number(p?.id);
      const firstTime =
        payId && !isNaN(payId)
          ? (pool ? await markPaymentLoggedDB(payId) : markPaymentLoggedRAM(payId))
          : false;
      if (firstTime) {
        logEvent({
          chatId,
          eventType:
            status === "approved" ? "payment_approved" :
            status === "pending" ? "payment_pending" :
            "payment_failed",
          planId,
          paymentId: payId || null,
          preferenceId: p?.order?.id ? String(p.order.id) : null,
          value: p?.transaction_amount ?? null,
          meta: { status, status_detail: p?.status_detail },
        }).catch(() => {});
        if (status === "pending" && chatId) {
          await tgSendMessage(chatId, SYS_TEXT.PAYMENT_PENDING);
        }
        if (status !== "approved" && status !== "pending" && chatId) {
          await tgSendMessage(chatId, SYS_TEXT.PAYMENT_FAILED);
        }
      }
      if (status !== "approved") return false;
      if (!chatId || !planId || !PLANS[planId]) return false;
      const current = await dbGetPremium(chatId);
      const active = current && Date.now() <= new Date(current.premium_until).getTime();
      if (!active) {
        await dbSetPremium(chatId, Date.now() + PLANS[planId].durationMs, planId);
        if (payId && !sentMetaEvents.has(payId)) {
          await sendMetaPurchase({ eventId: payId, value: p.transaction_amount, userId: chatId });
          sentMetaEvents.add(payId);
        }
        awaitingPayment.delete(chatId);
        lastCheckoutAt.delete(chatId);
        userMsgCount.delete(chatId);
        resetHot(chatId);
        await tgSendMessage(chatId, SYS_TEXT.PAYMENT_SUCCESS);
        console.log("✅ Premium ativado", { chatId, planId });
        return true;
      }
      return true;
    };
    if (String(topic).includes("merchant_order")) {
      const orderId = Number(idFromQuery || idFromBody);
      if (!orderId) return;
      const or = await fetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const order = await or.json();
      if (!or.ok) return;
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
    if (!paymentId || isNaN(paymentId)) return;
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
