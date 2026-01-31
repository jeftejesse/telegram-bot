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

// ========= PAYMENT DEDUPE (fallback sem DB) =========
const paymentDedupeRam = new Map(); // paymentId -> expiresAt
const PAYMENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cleanupPaymentDedupeRam() {
  const now = Date.now();
  for (const [id, expiresAt] of paymentDedupeRam.entries()) {
    if (expiresAt <= now) paymentDedupeRam.delete(id);
  }
}

function markPaymentLoggedRAM(paymentId) {
  const now = Date.now();
  const expiresAt = paymentDedupeRam.get(paymentId);
  if (expiresAt && expiresAt > now) return false; // já visto
  paymentDedupeRam.set(paymentId, now + PAYMENT_DEDUPE_TTL_MS);
  return true; // primeira vez
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
  return r.rowCount > 0; // true = inseriu de fato (primeira vez)
}

// ========= LIMPEZA DE PAYMENT_DEDUPE =========
async function dbCleanupOldPaymentDedupe(days = 30) {
  if (!pool) return;
  await pool.query(`DELETE FROM payment_dedupe WHERE created_at < NOW() - ($1::text)::interval`, [
    `${days} days`,
  ]);
}

// ========= DB HELPERS =========
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
  cleanupPaymentDedupeRam(); // limpa dedupe RAM também
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
  ).catch(() => {}); // fire-and-forget
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

async function tgTyping(chatId) {
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
  const systemPrompt = `...`; // ← seu system prompt continua igual (não colado aqui pra economizar espaço)

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
        model: "grok-4-latest",           // ← alterado aqui (ou grok-beta / grok-2-mini se disponível)
        messages,
        temperature: 0.7,
        top_p: 0.85,
        max_tokens: 70,
      }),
    });

    if (!resp.ok) throw new Error(`xAI HTTP ${resp.status}`);

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Resposta sem conteúdo válido");

    reply = String(content).trim();
  } catch (err) {
    console.error("Erro ao chamar xAI:", err?.message || err);
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
  // ... continua igual
}

// ========= MERCADO PAGO – CHECKOUT PRO =========
// ... continua igual (createCheckout, gerarCheckout)

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
    // ... continua igual (plan selection)
  }

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

  if (hitRateLimit(chatId)) {
    await tgSendMessage(chatId, "Calma comigo 😌 manda uma de cada vez.");
    tmark("Rate limit", t0);
    return;
  }

  if (msg.voice || msg.audio) {
    await tgSendMessage(chatId, SYS_TEXT.VOICE_BLOCK);
    tmark("Voice block", t0);
    return;
  }

  tgTyping(chatId);  // chamado cedo, sem await

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
    } else {
      premiumNow = true;
    }
  }

  const mediaAllowed = premiumNow && (planId === "p48h" || planId === "p7d");
  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|video|vídeo/i.test(text.toLowerCase());

  if (wantsMedia && !mediaAllowed) {
    // ... continua igual
  }

  if (justExpired) {
    // ... continua igual
  }

  if (!mediaAllowed) {
    if (hotWords.test(text.toLowerCase())) {
      // ... continua igual
    }
  }

  if (!loggedFirstMessage.has(chatId)) {
    logEvent({ chatId, eventType: "message_received" }).catch(() => {});
    loggedFirstMessage.add(chatId);
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
  if (premiumNow) pushHistory(chatId, "assistant", reply);  // só guarda se premium

  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  await tgSendMessage(chatId, reply);

  if (shouldUseQuickCache(norm)) setQuickCache(cacheKey, reply);

  tmark("Resposta IA enviada", t0);
});

// ========= WEBHOOK MP =========
// ... continua igual

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
