import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(cors());

// ---------------------
// MONGO CONNECTION
// ---------------------
const MONGO_URI = process.env.MONGO_URI;
await mongoose.connect(MONGO_URI, {});
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// ---------------------
// CHANNEL LIST CONFIG
// Edit this array to add/remove channels anytime.
// Every user must join ALL of these before accessing the app.
// ---------------------
export const REQUIRED_CHANNELS = [
  // ── Telegram channels (type: "telegram") ──────────────────────────────
  // username = the @username WITHOUT the @ sign. Used for getChatMember API.
  { type: "telegram", name: "Cash Hungama",  link: "https://t.me/+wxVjfol5y-9mODQ9",  username: "cashhungama"  },
  { type: "telegram", name: "Earn Daily",    link: "https://t.me/+NxHKX1IDRgg5ZDY1",    username: "earndaily"    },
  { type: "telegram", name: "Refer & Win",   link: "https://t.me/+1NkfO3yeXQ82ZmE1",  username: "referandwin"  },
  { type: "youtube", name: "Cash Hungama YT", link: "https://youtube.com/@yourchannel" },
];

// ---------------------
// SCHEMAS
// ---------------------
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    chatId: { type: String, unique: true },
    username: String,
    avatar: String,
    status: { type: String, default: "active" },
    referral_code: String,
    referred_by: String,
    channels_verified: { type: Boolean, default: false },
    channels_verified_at: Date,
    device_id: String,
    is_duplicate_device: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
  })
);

const Wallet = mongoose.model(
  "Wallet",
  new mongoose.Schema({
    chatId: { type: String, unique: true },
    balance: { type: Number, default: 0 },
    pending_balance: { type: Number, default: 0 },
    currency: { type: String, default: "INR" }
  })
);

const Txn = mongoose.model(
  "Txn",
  new mongoose.Schema({
    chatId: String,
    type: String,
    amount: Number,
    description: String,
    status: String,
    timestamp: { type: Date, default: Date.now },
    metadata: {}
  })
);

const UPI = mongoose.model(
  "UPI",
  new mongoose.Schema({
    chatId: { type: String, unique: true },
    vpa: String,
    bank_name: String,
    is_verified: Boolean,
    linked_at: Date
  })
);

const Referral = mongoose.model(
  "Referral",
  new mongoose.Schema({
    chatId: String,
    referral_code: String,
    referred_users: [
      {
        user_id: String,
        username: String,
        joined_at: Date,
        earned_amount: Number,
        is_active: Boolean
      }
    ],
    total_earned: { type: Number, default: 0 },
    pending_earned: { type: Number, default: 0 }
  })
);

const Withdraw = mongoose.model(
  "Withdraw",
  new mongoose.Schema({
    chatId: String,
    amount: Number,
    vpa: String,
    fee: Number,
    net_amount: Number,
    status: String,
    initiated_at: Date,
    completed_at: Date,
    transaction_id: String,
    failure_reason: String,
    admin_message_id: Number
  })
);

// ---------------------
// Helper Functions
// ---------------------
async function deleteAdminMessage(messageId) {
  if (!messageId) return;
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/deleteMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.ADMIN_CHAT_ID, message_id: messageId })
  });
}

async function normalizeWithdrawal(wd) {
  let changed = false;
  if (wd.fee === undefined || wd.fee === null) { wd.fee = 0; changed = true; }
  if (!wd.net_amount || wd.net_amount <= 0) { wd.net_amount = Math.max(wd.amount - wd.fee, 0); changed = true; }
  if (!["pending", "completed", "rejected"].includes(wd.status)) { wd.status = "pending"; changed = true; }
  if (changed) await wd.save();
  return wd;
}

async function ensureWallet(chatId) {
  let wallet = await Wallet.findOne({ chatId });
  if (!wallet) wallet = await Wallet.create({ chatId });
  return wallet;
}

async function sendUPIPayout(amount, vpa, info) {
  const url =
    `https://saathigateway.com/Api/` +
    `?token=I7YPLYA5WASR7WJ0` +
    `&key=tAv965PSmcEMIyMLMIkECpyA` +
    `&upi=${encodeURIComponent(vpa)}` +
    `&amount=10` +
    `&comment=paid`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "success") return { success: false, raw: data };
  return { success: true, txn_id: data.txnid, amount_sent: data.amount_sent, charged: data.charged };
}

async function notifyAdminWithButtons(text, buttons) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.ADMIN_CHAT_ID,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
      })
    });
    const data = await res.json();
    if (!data.ok || !data.result) { console.error("Telegram sendMessage failed:", data); return null; }
    return data.result.message_id;
  } catch (err) { console.error("Telegram API error:", err); return null; }
}

async function notifyUser(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}

// ---------------------
// Channel membership check via Telegram Bot API
// Returns true if user is a member/admin/creator of the channel
// ---------------------
async function checkChannelMembership(chatId, channelUsername) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: `@${channelUsername}`,
        user_id: Number(chatId)
      })
    });
    const data = await res.json();
    if (!data.ok) return false;
    const status = data.result?.status;
    // Valid statuses: member, administrator, creator, restricted (still a member)
    // Invalid: left, kicked
    return ["member", "administrator", "creator", "restricted"].includes(status);
  } catch (e) {
    console.error(`Membership check failed for @${channelUsername}:`, e.message);
    return false; // fail safe: treat as not joined
  }
}

// ----------------------------------------------
// 1. USER API
// ----------------------------------------------
app.get("/api/user/info", async (req, res) => {
  const { chatId, username, avatar } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  let user = await User.findOne({ chatId });
  if (!user) {
    const referralCode = Math.floor(100000 + Math.random() * 900000).toString();
    user = await User.create({ chatId, username, avatar, referral_code: referralCode });
    await ensureWallet(chatId);
  } else {
    user.username = username || user.username;
    user.avatar = avatar || user.avatar;
    await user.save();
  }
  res.json(user);
});

// ----------------------------------------------
// 2. WALLET
// ----------------------------------------------
app.get("/api/wallet/balance", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const wallet = await ensureWallet(chatId);
  res.json({
    balance: wallet.balance.toFixed(2),
    available_balance: wallet.balance.toFixed(2),
    pending_balance: wallet.pending_balance.toFixed(2),
    currency: wallet.currency
  });
});

app.get("/api/wallet/transactions", async (req, res) => {
  const { chatId, limit = 20, offset = 0 } = req.query;
  const tx = await Txn.find({ chatId }).sort({ timestamp: -1 }).skip(Number(offset)).limit(Number(limit));
  const total = await Txn.countDocuments({ chatId });
  res.json({ transactions: tx, total });
});

// ----------------------------------------------
// 3. UPI
// ----------------------------------------------
app.get("/api/upi", async (req, res) => {
  const { chatId, vpa, bank_name } = req.query;
  let upi = await UPI.findOne({ chatId });
  if (!upi) {
    upi = await UPI.create({ chatId, vpa, bank_name, is_verified: !!vpa, linked_at: vpa ? new Date() : null });
  } else {
    if (vpa) { upi.vpa = vpa; upi.is_verified = true; upi.linked_at = new Date(); }
    if (bank_name) upi.bank_name = bank_name;
    await upi.save();
  }
  res.json(upi);
});

// ----------------------------------------------
// 4. WITHDRAWAL
// ----------------------------------------------
app.post("/api/withdraw/initiate", async (req, res) => {
  const { chatId, amount, vpa } = req.body;
  const withdrawAmount = Number(amount);
  if (!chatId || !withdrawAmount || !vpa) return res.status(400).json({ error: "Invalid request" });

  const wallet = await ensureWallet(chatId);
  if (wallet.balance < withdrawAmount) return res.json({ error: "Insufficient balance" });

  wallet.balance -= withdrawAmount;
  await wallet.save();

  const wd = await Withdraw.create({
    chatId, amount: withdrawAmount, fee: 5, net_amount: withdrawAmount,
    vpa, status: "processing", initiated_at: new Date()
  });

  await Txn.create({
    chatId, type: "debit", amount: withdrawAmount,
    description: "Withdrawal", status: "processing", metadata: { withdrawal_id: wd._id }
  });

  try {
    const payout = await sendUPIPayout(withdrawAmount, vpa, `Withdrawal ${wd._id}`);
    if (!payout || payout.success !== true) throw new Error("Payout failed");

    wd.status = "completed"; wd.completed_at = new Date(); wd.transaction_id = payout.txn_id;
    await wd.save();
    await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "success" });
    await notifyUser(chatId, `✅ Withdrawal Successful\n\n₹${withdrawAmount} sent to ${vpa}\nTxn ID: ${payout.txn_id}`);
    return res.json({ success: true, txn_id: payout.txn_id, amount: withdrawAmount });
  } catch (err) {
    console.error("[AUTO PAYOUT FAILED]", err);
    wallet.balance += withdrawAmount; await wallet.save();
    wd.status = "failed"; wd.failure_reason = "Payout failed"; await wd.save();
    await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "failed" });
    await notifyUser(chatId, `❌ Withdrawal Failed\n\n₹${withdrawAmount} refunded to wallet`);
    return res.json({ error: "Payout failed, amount refunded" });
  }
});

// ----------------------------------------------
// 5. REFERRAL SUMMARY
// ----------------------------------------------
app.get("/api/referral", async (req, res) => {
  const { chatId } = req.query;
  const user = await User.findOne({ chatId });
  const ref = await Referral.findOne({ chatId });
  res.json({
    code: user.referral_code,
    link: `https://t.me/winzoplay_bot?start=${user.referral_code}`,
    total_referrals: ref?.referred_users.length || 0,
    successful_referrals: ref?.referred_users.filter(x => x.is_active).length || 0,
    total_earned: (ref?.total_earned || 0).toFixed(2),
    pending_earned: (ref?.pending_earned || 0).toFixed(2),
    commission_per_referral: "5.00"
  });
});

// ----------------------------------------------
// 6. REFERRAL USER LIST
// ----------------------------------------------
app.get("/api/referral/users", async (req, res) => {
  const { chatId } = req.query;
  const ref = await Referral.findOne({ chatId });
  res.json({ referrals: ref?.referred_users || [], total: ref?.referred_users.length || 0 });
});

// ----------------------------------------------
// 7. BOT REFERRAL
// ----------------------------------------------
app.all("/api/bot/refer", async (req, res) => {
  try {
    const data = req.method === "GET" ? req.query : req.body;
    const { chatId, username, avatar, ref, duplicate_device, device_id } = data;
    if (!chatId) return res.status(400).json({ success: false, error: "chatId required" });

    let user = await User.findOne({ chatId });
    if (!user) {
      const referralCode = Math.floor(100000 + Math.random() * 900000).toString();
      user = await User.create({
        chatId, username, avatar, referral_code: referralCode,
        referred_by: ref || null,
        device_id: device_id || null,
        is_duplicate_device: duplicate_device || false
      });
      await ensureWallet(chatId);
    }

    if (ref) {
      const inviter = await User.findOne({ referral_code: ref });
      if (inviter) {
        let refDoc = await Referral.findOne({ chatId: inviter.chatId });
        if (!refDoc) refDoc = await Referral.create({ chatId: inviter.chatId, referral_code: inviter.referral_code, referred_users: [] });
        refDoc.referred_users.push({ user_id: chatId, username: username || "", joined_at: new Date(), earned_amount: 5, is_active: true });
        refDoc.total_earned += 5;
        await refDoc.save();
        let inviterWallet = await ensureWallet(inviter.chatId);
        inviterWallet.balance += 5; await inviterWallet.save();
        await Txn.create({ chatId: inviter.chatId, type: "credit", amount: 5, description: "Referral Reward", status: "success", metadata: { referred_user: chatId } });
        await notifyUser(inviter.chatId, `🎉You earned 5 as invite bonus! The user ${chatId} registered using your link.`);
      }
    }

    res.json({ success: true, referral_code: user.referral_code, referred_by: user.referred_by });
  } catch (err) {
    console.error("Referral error:", err);
    res.json({ success: false });
  }
});

// ----------------------------------------------
// 8. WITHDRAW HISTORY
// ----------------------------------------------
app.get("/api/withdraw/history", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const withdrawals = await Withdraw.find({ chatId }).sort({ initiated_at: -1 });
  res.json({
    total: withdrawals.length,
    withdrawals: withdrawals.map(w => ({
      id: w._id, amount: w.amount, fee: w.fee, net_amount: w.net_amount,
      status: w.status, vpa: w.vpa, initiated_at: w.initiated_at,
      completed_at: w.completed_at, transaction_id: w.transaction_id, failure_reason: w.failure_reason
    }))
  });
});

// ----------------------------------------------
// 9. ADMIN: UPDATE WITHDRAW STATUS
// ----------------------------------------------
app.get("/api/withdraw/update", async (req, res) => {
  const { id, status, failure_reason } = req.query;
  let wd = await Withdraw.findById(id);
  if (!wd) return res.json({ error: "Not found" });
  wd = await normalizeWithdrawal(wd);
  if (wd.status !== "pending") return res.json({ error: "Already processed" });

  if (status === "completed") {
    try {
      const payout = await sendUPIPayout(wd.net_amount, wd.vpa, `Withdrawal`);
      if (!payout || payout.success !== true) return res.json({ error: "Payout failed", details: payout });
      wd.status = "completed"; wd.completed_at = new Date(); wd.transaction_id = payout.txn_id;
      await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "success" });
      await notifyUser(wd.chatId, `✅ Withdrawal Successful\n₹${wd.net_amount} sent\nTxn ID: ${wd.transaction_id}`);
      await deleteAdminMessage(wd.admin_message_id);
    } catch (err) {
      return res.json({ error: "Exception during payout", details: err.message });
    }
  }

  if (status === "rejected") {
    wd.status = "rejected"; wd.failure_reason = failure_reason || "Policy Violation";
    await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "failed" });
    await notifyUser(wd.chatId, `❌ Withdrawal Rejected\nReason: ${wd.failure_reason}\n\n⚠️ Amount forfeited`);
  }

  await wd.save();
  await deleteAdminMessage(wd.admin_message_id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════
// 10. CHANNEL VERIFICATION  ← NEW ROUTES
// ══════════════════════════════════════════════

/**
 * GET /api/channels/list
 * Returns the full channel list (without usernames, frontend-safe)
 */
app.get("/api/channels/list", (req, res) => {
  res.json({
    channels: REQUIRED_CHANNELS.map(ch => ({
      name: ch.name,
      link: ch.link,
      type: ch.type || 'telegram'   // frontend uses this to show YouTube vs Telegram icon
    }))
  });
});

/**
 * POST /api/channels/check
 * Body: { chatId: "123456789" }
 *
 * Checks every channel in REQUIRED_CHANNELS via Telegram getChatMember.
 * Returns:
 *   { allJoined: true }                              — if all joined
 *   { allJoined: false, pending: [{name, link}, …] } — channels still to join
 */
app.post("/api/channels/check", async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  // Run all membership checks in parallel.
  // YouTube entries are auto-passed (cannot verify via Telegram API).
  const results = await Promise.all(
    REQUIRED_CHANNELS.map(async (ch) => {
      if (ch.type === 'youtube') {
        // Cannot verify YouTube subscription server-side — treat as passed.
        return { ...ch, joined: true };
      }
      const joined = await checkChannelMembership(chatId, ch.username);
      return { ...ch, joined };
    })
  );

  const pending = results
    .filter(ch => !ch.joined)
    .map(ch => ({ name: ch.name, link: ch.link }));

  const allJoined = pending.length === 0;

  // If all joined, mark user as channels_verified in DB
  if (allJoined) {
    try {
      await User.findOneAndUpdate(
        { chatId: String(chatId) },
        { channels_verified: true, channels_verified_at: new Date() },
        { upsert: false }
      );
    } catch (e) {
      // Non-fatal: user record may not exist yet if they bypassed user/info
      console.warn("Could not update channels_verified for", chatId);
    }
  }

  res.json({ allJoined, pending, total: REQUIRED_CHANNELS.length, joined: REQUIRED_CHANNELS.length - pending.length });
});

/**
 * GET /api/channels/status?chatId=xxx
 * Quick check: returns cached DB flag (channels_verified)
 * Use this for fast re-entry without re-calling Telegram API.
 */
app.get("/api/channels/status", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  const user = await User.findOne({ chatId });
  if (!user) return res.json({ verified: false });

  res.json({
    verified: user.channels_verified || false,
    verified_at: user.channels_verified_at || null
  });
});

// ----------------------------------------------
export default app;
