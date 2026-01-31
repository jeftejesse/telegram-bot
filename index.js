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
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não definido");

// ========= PLANOS =========
const PLANS = {
  p12h: { id: "p12h", label: "12 horas", amount: 49.90, durationMs: 12 * 60 * 60 * 1000 },
  p48h: { id: "p48h", label: "48 horas", amount: 97.90, durationMs: 48 * 60 * 60 * 1000 },
  p7d:  { id: "p7d",  label: "7 dias",    amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const CHECKOUT_COOLDOWN_MS = 30 * 1000; // 30 segundos anti-clique repetido

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const MAX_MESSAGES = 20;
const userMsgCount = new Map();
const awaitingPayment = new Map();
const lastCheckoutAt = new Map();
const sentMetaEvents = new Set();

// ========= DB (Postgres) =========
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function dbInit() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premiums (
      chat_id BIGINT PRIMARY KEY,
      premium_until TIMESTAMPTZ NOT NULL
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
  await pool.query(`CREATE INDEX IF NOT EXISTS pendings_created_at_idx ON pendings(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pendings_chat_id_idx ON pendings(chat_id);`);
  console.log("✅ DB pronto");
}

// ─── Premium DB helpers ──────────────────────────────────────────────
async function dbGetPremiumUntil(chatId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT premium_until FROM premiums WHERE chat_id = $1`, [chatId]);
  if (!r.rowCount) return null;
  return new Date(r.rows[0].premium_until).getTime();
}

async function dbSetPremiumUntil(chatId, untilMs) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO premiums (chat_id, premium_until)
    VALUES ($1, to_timestamp($2 / 1000.0))
    ON CONFLICT (chat_id) DO UPDATE SET premium_until = EXCLUDED.premium_until
  `,
    [chatId, untilMs]
  );
}

async function dbDeletePremium(chatId) {
  if (!pool) return;
  await pool.query(`DELETE FROM premiums WHERE chat_id = $1`, [chatId]);
}

async function isPremium(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  return !!until && Date.now() <= until;
}

async function clearIfExpired(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  if (until && Date.now() > until) {
    await dbDeletePremium(chatId);
    return true;
  }
  return false;
}

// ─── Pendings ────────────────────────────────────────────────────────
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
  const r = await pool.query(`SELECT * FROM pendings WHERE preference_id = $1`, [preferenceId]);
  return r.rowCount ? r.rows[0] : null;
}

async function dbDeletePending(preferenceId) {
  if (!pool) return;
  await pool.query(`DELETE FROM pendings WHERE preference_id = $1`, [preferenceId]);
}

async function dbCleanupOldPendings(ttlMs) {
  if (!pool) return;
  await pool.query(
    `DELETE FROM pendings WHERE created_at < NOW() - ($1::text)::interval`,
    [`${Math.floor(ttlMs / 1000)} seconds`]
  );
}

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

async function tgSendMessage(chatId, text, extra = {}) {
  try {
    const body = { chat_id: chatId, text, disable_web_page_preview: true, ...extra };
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.error("Telegram sendMessage FAIL:", j);
    return { ok: j.ok };
  } catch (e) {
    console.error("Telegram error:", e.message);
    return { ok: false };
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
    if (!j.ok) console.error("sendPaymentButton FAIL:", j);
    return { ok: j.ok };
  } catch (e) {
    console.error("tgSendPaymentButton error:", e);
    return { ok: false };
  }
}

async function sendPlansButtons(chatId) {
  const body = {
    chat_id: chatId,
    text: "Escolhe o pacotinho que combina com a gente hoje 😈💦",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 12 horas — R$ 49,90 (Só texto)", callback_data: "plan_p12h" }],
        [{ text: "😈 48 horas — R$ 97,90 ⭐ Texto + Áudio + Fotos + Vídeos", callback_data: "plan_p48h" }],
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
  await tgSendMessage(
    chatId,
    "Ain amor… 😌\nIsso eu só faço quando fico a sós com quem escolhe o plano premium.\n\nNo texto eu provoco…\nmas áudio, foto e vídeo são só pra quem aceita ir além 😈🔥"
  );

  await sendPlansButtons(chatId);
}

async function gerarCheckout(chatId, planId) {
  const now = Date.now();
  const last = lastCheckoutAt.get(chatId) || 0;
  if (now - last < CHECKOUT_COOLDOWN_MS) {
    await tgSendMessage(chatId, "Calma 😌 já tô gerando o link… tenta de novo em alguns segundinhos.");
    return;
  }
  lastCheckoutAt.set(chatId, now);

  try {
    const { checkoutUrl, plan } = await createCheckout({ chatId, planId });
    console.log("✅ Checkout criado:", { chatId, planId: plan.id, checkoutUrl });

    let paymentText = "";

    if (plan.id === "p12h") {
      paymentText =
        `🔥 <b>Plano 12 horas</b> – <b>R$ 49,90</b>\n\n` +
        `👇 Clique no botão abaixo para pagar (Pix ou Cartão)\n\n` +
        `⏳ Assim que aprovado, libero o acesso 😈`;
    }

    if (plan.id === "p48h") {
      paymentText =
        `😈 <b>Plano 48 horas</b> – <b>R$ 97,90</b> ⭐\n` +
        `<b>Texto + Áudio + Fotos + Vídeos</b>\n\n` +
        `Aqui eu paro de só provocar…\n` +
        `fico mais próxima, mais intensa, mais real 😏\n\n` +
        `👇 Clique abaixo pra liberar tudo:`;
    }

    if (plan.id === "p7d") {
      paymentText =
        `💦 <b>Plano 7 dias</b> – <b>R$ 197,90</b> 🔥\n` +
        `<b>Texto + Áudio + Fotos + Vídeos (sem limites)</b>\n\n` +
        `Aqui é outro nível…\n` +
        `sem pressa, sem freio, sem faltar nada 😈\n\n` +
        `👇 Clique abaixo pra ficar comigo de verdade:`;
    }

    await tgSendPaymentButton(chatId, paymentText, checkoutUrl);
    awaitingPayment.set(chatId, true);
    resetInactivityTimer(chatId);
  } catch (err) {
    console.error("❌ Erro ao gerar checkout:", err?.message || err);
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    await tgSendMessage(chatId, "Ops… deu algum probleminha ao gerar o pagamento 😔 Tenta de novo?");
  }
}

async function cleanupOldPendings() {
  await dbCleanupOldPendings(PENDING_TTL_MS);
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

// ... (sendMetaPurchase, createCheckout, rotas /mp/*, fetchWithRetry, askGrok, timers de inatividade permanecem iguais)

// ========= WEBHOOK MP =========
app.post("/mp/webhook", async (req, res) => {
  console.log("🔔 MP WEBHOOK:", JSON.stringify(req.body), JSON.stringify(req.query));
  res.sendStatus(200);

  try {
    // ... (lógica existente de topic, merchant_order, paymentId, etc.)

    // Dentro da função activateFromPayment, após ativar o premium:
    // (já estava presente, mas reforçando que deve ter isso)
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    userMsgCount.delete(chatId);

    // ... resto do código de ativação, envio de mensagem de sucesso, etc.
  } catch (e) {
    console.error("MP webhook error:", e.message);
  }
});

// ========= WEBHOOK TELEGRAM =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

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

    if (data === "plan_p12h") return gerarCheckout(chatId, "p12h");
    if (data === "plan_p48h") return gerarCheckout(chatId, "p48h");
    if (data === "plan_p7d")  return gerarCheckout(chatId, "p7d");
    return;
  }

  await cleanupOldPendings();

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  // Calcula premium UMA ÚNICA VEZ por update
  const premiumNow = await isPremium(chatId);

  if (msg.voice || msg.audio) {
    await tgSendMessage(
      chatId,
      "Ain vamos conversar assim escrevendo, eu sinto mais tesão lendo o que você escreve 💕"
    );
    resetInactivityTimer(chatId);
    return;
  }

  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|fala comigo|me manda|video|vídeo/i.test(
    text.toLowerCase()
  );

  if (wantsMedia) {
    if (premiumNow) {
      await tgSendMessage(
        chatId,
        "Calma… 😏\nDeixa eu escolher direitinho o que te mandar…"
      );
      resetInactivityTimer(chatId);
      return;
    }

    // Evita spam de botões se já está aguardando pagamento
    if (awaitingPayment.get(chatId)) {
      await tgSendMessage(chatId, "Hehe 😏 é só escolher um plano ali que eu libero.");
      resetInactivityTimer(chatId);
      return;
    }

    awaitingPayment.set(chatId, true);
    await sendPremiumOnlyNotice(chatId);
    resetInactivityTimer(chatId);
    return;
  }

  console.log("🔥 UPDATE:", chatId, text);

  if (text === "/start") {
    await tgSendMessage(chatId, "Oii amorzinho…😊\n Gosto de conversa boa gente interessante.\n Você é mais tímido ou ousado?");
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(chatId, "Tá bom docinho… 😊 paro por aqui. Volta quando quiser 💕");
    memory.delete(chatId);
    userMsgCount.delete(chatId);
    awaitingPayment.delete(chatId);
    await dbDeletePremium(chatId);
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

  const justExpired = await clearIfExpired(chatId);
  pushHistory(chatId, "user", text);
  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  try {
    if (premiumNow) {
      const reply = await askGrok(chatId, text);
      pushHistory(chatId, "assistant", reply);
      await tgSendMessage(chatId, reply);
      resetInactivityTimer(chatId);
      return;
    }

    if (justExpired) {
      awaitingPayment.set(chatId, true);
      await sendPremiumOnlyNotice(chatId);
      return;
    }

    const history = getHistory(chatId);
    const msgCount = userMsgCount.get(chatId) || 0;
    const lastMsgs = history.slice(-5).map(m => m.content.toLowerCase()).join(' ');
    const isPaymentTime =
      msgCount >= 10 &&
      msgCount <= 14 &&
      /calorzinho|coxa|abraço|beijo|tesão|gostei|molhada|duro/.test(lastMsgs);

    if (isPaymentTime) {
      awaitingPayment.set(chatId, true);
      await sendPremiumOnlyNotice(chatId);
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

dbInit()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ Falha ao iniciar DB:", e.message);
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  });
