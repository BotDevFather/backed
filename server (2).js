import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());

const MONGO_URI = process.env.MONGO_URI;
await mongoose.connect(MONGO_URI, {});
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

export const REQUIRED_CHANNELS = [
  { type: "telegram", name: "Cash Hungama",   link: "https://t.me/+wxVjfol5y-9mODQ9",  chatId: "-1003535064379" },
  { type: "telegram", name: "Earn Daily",     link: "https://t.me/+NxHKX1IDRgg5ZDY1",  chatId: "-1003891165485" },
  { type: "telegram", name: "Refer & Win",    link: "https://t.me/+1NkfO3yeXQ82ZmE1",  chatId: "-1003856337430" },
  { type: "youtube",  name: "Cash Hungama YT", link: "https://youtube.com/@yourchannel" },
];

const User = mongoose.model("User", new mongoose.Schema({
  chatId:               { type: String, unique: true },
  username:             String,
  avatar:               String,
  status:               { type: String, default: "active" },
  referral_code:        String,
  referred_by:          String,
  channels_verified:    { type: Boolean, default: false },
  channels_verified_at: Date,
  device_id:            String,
  is_duplicate_device:  { type: Boolean, default: false },
  device_blocked:       { type: Boolean, default: false },
  device_blocked_reason: String,
  created_at:           { type: Date, default: Date.now }
}));

const DeviceRegistry = mongoose.model("DeviceRegistry", new mongoose.Schema({
  device_id:        { type: String, unique: true },
  chatId:           String,
  blocked_chatIds:  [String],
  created_at:       { type: Date, default: Date.now },
  updated_at:       { type: Date, default: Date.now }
}));

const Wallet = mongoose.model("Wallet", new mongoose.Schema({
  chatId:          { type: String, unique: true },
  balance:         { type: Number, default: 0 },
  pending_balance: { type: Number, default: 0 },
  currency:        { type: String, default: "INR" }
}));

const Txn = mongoose.model("Txn", new mongoose.Schema({
  chatId: String, type: String, amount: Number,
  description: String, status: String,
  timestamp: { type: Date, default: Date.now }, metadata: {}
}));

const UPI = mongoose.model("UPI", new mongoose.Schema({
  chatId: { type: String, unique: true }, vpa: String,
  bank_name: String, is_verified: Boolean, linked_at: Date
}));

const Referral = mongoose.model("Referral", new mongoose.Schema({
  chatId: String, referral_code: String,
  referred_users: [{
    user_id: String, username: String, joined_at: Date,
    earned_amount: Number, is_active: Boolean
  }],
  total_earned:   { type: Number, default: 0 },
  pending_earned: { type: Number, default: 0 }
}));

const Withdraw = mongoose.model("Withdraw", new mongoose.Schema({
  chatId: String, amount: Number, vpa: String, fee: Number,
  net_amount: Number, status: String, initiated_at: Date,
  completed_at: Date, transaction_id: String,
  failure_reason: String, admin_message_id: Number
}));

async function deleteAdminMessage(messageId) {
  if (!messageId) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, message_id: messageId })
  });
}

async function normalizeWithdrawal(wd) {
  let changed = false;
  if (wd.fee == null) { wd.fee = 0; changed = true; }
  if (!wd.net_amount || wd.net_amount <= 0) { wd.net_amount = Math.max(wd.amount - wd.fee, 0); changed = true; }
  if (!["pending","completed","rejected"].includes(wd.status)) { wd.status = "pending"; changed = true; }
  if (changed) await wd.save();
  return wd;
}

async function ensureWallet(chatId) {
  let w = await Wallet.findOne({ chatId });
  if (!w) w = await Wallet.create({ chatId });
  return w;
}

async function sendUPIPayout(amount, vpa) {
  const url = `https://saathigateway.com/Api/`
    + `?token=I7YPLYA5WASR7WJ0&key=tAv965PSmcEMIyMLMIkECpyA`
    + `&upi=${encodeURIComponent(vpa)}&amount=10&comment=paid`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "success") return { success: false, raw: data };
  return { success: true, txn_id: data.txnid };
}

async function notifyUser(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}

async function checkChannelMembership(userChatId, channelChatId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelChatId, user_id: Number(userChatId) })
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn(`[getChatMember] channel=${channelChatId} user=${userChatId}:`, data.description);
      return false;
    }
    const status = data.result?.status;
    console.log(`[getChatMember] channel=${channelChatId} user=${userChatId} status=${status}`);
    return ["member", "administrator", "creator", "restricted"].includes(status);
  } catch (e) {
    console.error(`[getChatMember] Exception:`, e.message);
    return false;
  }
}

// 1. USER API
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
    user.avatar   = avatar   || user.avatar;
    await user.save();
  }
  res.json(user);
});

// 2. WALLET
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
  const tx    = await Txn.find({ chatId }).sort({ timestamp: -1 }).skip(+offset).limit(+limit);
  const total = await Txn.countDocuments({ chatId });
  res.json({ transactions: tx, total });
});

// 3. UPI
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

// 4. WITHDRAWAL
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
  await Txn.create({ chatId, type: "debit", amount: withdrawAmount,
    description: "Withdrawal", status: "processing", metadata: { withdrawal_id: wd._id } });
  try {
    const payout = await sendUPIPayout(withdrawAmount, vpa);
    if (!payout?.success) throw new Error("Payout failed");
    wd.status = "completed"; wd.completed_at = new Date(); wd.transaction_id = payout.txn_id;
    await wd.save();
    await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "success" });
    await notifyUser(chatId, `✅ Withdrawal Successful\n\n₹${withdrawAmount} sent to ${vpa}\nTxn ID: ${payout.txn_id}`);
    return res.json({ success: true, txn_id: payout.txn_id, amount: withdrawAmount });
  } catch (err) {
    wallet.balance += withdrawAmount; await wallet.save();
    wd.status = "failed"; wd.failure_reason = "Payout failed"; await wd.save();
    await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "failed" });
    await notifyUser(chatId, `❌ Withdrawal Failed\n\n₹${withdrawAmount} refunded to wallet`);
    return res.json({ error: "Payout failed, amount refunded" });
  }
});

// 5. REFERRAL SUMMARY
app.get("/api/referral", async (req, res) => {
  const { chatId } = req.query;
  const user = await User.findOne({ chatId });
  const ref  = await Referral.findOne({ chatId });
  res.json({
    code: user?.referral_code || "",
    link: `https://t.me/winzoplay_bot?start=${user?.referral_code || ""}`,
    total_referrals:         ref?.referred_users.length || 0,
    successful_referrals:    ref?.referred_users.filter(x => x.is_active).length || 0,
    total_earned:            (ref?.total_earned || 0).toFixed(2),
    pending_earned:          (ref?.pending_earned || 0).toFixed(2),
    commission_per_referral: "5.00",
    is_duplicate_device:     user?.is_duplicate_device || false
  });
});

// 6. REFERRAL USER LIST
app.get("/api/referral/users", async (req, res) => {
  const { chatId } = req.query;
  const ref = await Referral.findOne({ chatId });
  res.json({ referrals: ref?.referred_users || [], total: ref?.referred_users.length || 0 });
});

// 7. BOT REFERRAL — register + conditional reward
app.all("/api/bot/refer", async (req, res) => {
  try {
    const data = req.method === "GET" ? req.query : req.body;
    const { chatId, username, avatar, ref, duplicate_device, device_id } = data;
    if (!chatId) return res.status(400).json({ success: false, error: "chatId required" });

    // Is THIS new signup a duplicate device?
    const isDuplicateUser = duplicate_device === true || duplicate_device === "true";

    let user = await User.findOne({ chatId });
    if (!user) {
      const referralCode = Math.floor(100000 + Math.random() * 900000).toString();
      user = await User.create({
        chatId, username, avatar, referral_code: referralCode,
        referred_by: ref || null,
        device_id: device_id || null,
        is_duplicate_device: isDuplicateUser,
        device_blocked: false
      });
      await ensureWallet(chatId);
    }

    // Give reward ONLY if new user is NOT a duplicate device
    if (ref && user.referred_by === (ref || null)) {
      const inviter = await User.findOne({ referral_code: ref });
      if (inviter) {
        if (isDuplicateUser) {
          // Duplicate — skip reward, notify inviter
          console.log(`[Referral] Skipped — referred user ${chatId} is duplicate device`);
          await notifyUser(inviter.chatId, `⚠️ A user joined via your link but was detected as a duplicate device. No reward added.`);
        } else {
          let refDoc = await Referral.findOne({ chatId: inviter.chatId });
          if (!refDoc) refDoc = await Referral.create({ chatId: inviter.chatId, referral_code: inviter.referral_code, referred_users: [] });
          const alreadyRewarded = refDoc.referred_users.some(u => u.user_id === chatId);
          if (!alreadyRewarded) {
            const rewardAmount = 5;
            refDoc.referred_users.push({ user_id: chatId, username: username || "", joined_at: new Date(), earned_amount: rewardAmount, is_active: true });
            refDoc.total_earned += rewardAmount;
            await refDoc.save();
            const inviterWallet = await ensureWallet(inviter.chatId);
            inviterWallet.balance += rewardAmount; await inviterWallet.save();
            await Txn.create({ chatId: inviter.chatId, type: "credit", amount: rewardAmount,
              description: "Referral Reward", status: "success", metadata: { referred_user: chatId } });
            await notifyUser(inviter.chatId, `🎉 You earned ₹${rewardAmount} as invite bonus! User registered via your link.`);
          }
        }
      }
    }

    res.json({ success: true, referral_code: user.referral_code, referred_by: user.referred_by, is_duplicate_device: user.is_duplicate_device || false });
  } catch (err) {
    console.error("Referral error:", err);
    res.json({ success: false });
  }
});

// 8. WITHDRAW HISTORY
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

// 9. ADMIN: UPDATE WITHDRAW STATUS
app.get("/api/withdraw/update", async (req, res) => {
  const { id, status, failure_reason } = req.query;
  let wd = await Withdraw.findById(id);
  if (!wd) return res.json({ error: "Not found" });
  wd = await normalizeWithdrawal(wd);
  if (wd.status !== "pending") return res.json({ error: "Already processed" });
  if (status === "completed") {
    try {
      const payout = await sendUPIPayout(wd.net_amount, wd.vpa);
      if (!payout?.success) return res.json({ error: "Payout failed", details: payout });
      wd.status = "completed"; wd.completed_at = new Date(); wd.transaction_id = payout.txn_id;
      await Txn.updateOne({ "metadata.withdrawal_id": wd._id }, { status: "success" });
      await notifyUser(wd.chatId, `✅ Withdrawal Successful\n₹${wd.net_amount} sent\nTxn ID: ${wd.transaction_id}`);
      await deleteAdminMessage(wd.admin_message_id);
    } catch (err) { return res.json({ error: "Exception during payout", details: err.message }); }
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

// 10. CHANNEL VERIFICATION
app.get("/api/channels/list", (req, res) => {
  try {
    res.json({ channels: REQUIRED_CHANNELS.map(ch => ({ name: ch.name, link: ch.link, type: ch.type || "telegram" })) });
  } catch (e) {
    res.status(500).json({ error: "Failed to load channel list", channels: [] });
  }
});

app.post("/api/channels/check", async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    const results = await Promise.all(
      REQUIRED_CHANNELS.map(async (ch) => {
        if (ch.type === "youtube") return { ...ch, joined: true };
        const joined = await checkChannelMembership(chatId, ch.chatId);
        return { ...ch, joined };
      })
    );
    const pending   = results.filter(ch => !ch.joined).map(ch => ({ name: ch.name, link: ch.link }));
    const allJoined = pending.length === 0;
    if (allJoined) {
      await User.findOneAndUpdate({ chatId: String(chatId) },
        { channels_verified: true, channels_verified_at: new Date() }, { upsert: false })
        .catch(e => console.warn("Could not update channels_verified:", e.message));
    } else {
      // Clear verified flag so next boot re-checks live
      await User.findOneAndUpdate({ chatId: String(chatId) },
        { channels_verified: false }, { upsert: false }).catch(() => {});
    }
    res.json({ allJoined, pending, total: REQUIRED_CHANNELS.length, joined: REQUIRED_CHANNELS.length - pending.length });
  } catch (e) {
    console.error("[channels/check]", e.message);
    res.status(500).json({ error: "Channel check failed: " + e.message });
  }
});

app.get("/api/channels/status", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const user = await User.findOne({ chatId });
  if (!user) return res.json({ verified: false });
  res.json({ verified: user.channels_verified || false, verified_at: user.channels_verified_at || null });
});

// 11. DEVICE VERIFICATION
// duplicate_device: true  → App access allowed, referral rewards blocked
// blocked: true           → Hard block (only set manually by admin)
app.post("/api/device/check", async (req, res) => {
  const { chatId, device_id } = req.body;
  if (!chatId || !device_id) return res.json({ blocked: false, duplicate_device: false });

  try {
    // Check if this user has been manually hard-blocked by admin
    const user = await User.findOne({ chatId: String(chatId) });
    if (user?.device_blocked) {
      return res.json({ blocked: true, duplicate_device: true, reason: user.device_blocked_reason || "Device blocked by admin" });
    }

    let registry = await DeviceRegistry.findOne({ device_id });

    if (!registry) {
      // First time — register device
      await DeviceRegistry.create({ device_id, chatId: String(chatId) });
      console.log(`[Device] Registered ${device_id.slice(0,12)}... → user ${chatId}`);
      return res.json({ blocked: false, duplicate_device: false });
    }

    if (registry.chatId === String(chatId)) {
      // Same user, same device — fine
      return res.json({ blocked: false, duplicate_device: false });
    }

    // Different user on same device — flag as duplicate (NOT hard blocked)
    console.warn(`[Device] DUPLICATE: ${device_id.slice(0,12)}... belongs to ${registry.chatId}, new user ${chatId}`);

    if (!registry.blocked_chatIds.includes(String(chatId))) {
      registry.blocked_chatIds.push(String(chatId));
      registry.updated_at = new Date();
      await registry.save();
    }

    // Mark user as duplicate in DB (but NOT device_blocked — they can still use app)
    await User.findOneAndUpdate(
      { chatId: String(chatId) },
      { is_duplicate_device: true, device_blocked: false },
      { upsert: false }
    ).catch(() => {});

    return res.json({
      blocked: false,          // ← App access allowed
      duplicate_device: true,  // ← Referral rewards will be blocked
      reason: "Duplicate device — referral earnings disabled"
    });

  } catch (e) {
    console.error("[device/check] Error:", e.message);
    return res.json({ blocked: false, duplicate_device: false }); // fail open
  }
});

// Admin: unblock a user
app.post("/api/device/unblock", async (req, res) => {
  const { chatId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  try {
    await User.findOneAndUpdate({ chatId: String(chatId) },
      { device_blocked: false, device_blocked_reason: null, is_duplicate_device: false },
      { upsert: false });
    // Also remove from DeviceRegistry blocked list
    await DeviceRegistry.updateMany({}, { $pull: { blocked_chatIds: String(chatId) } });
    res.json({ success: true, message: `User ${chatId} fully unblocked` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: get duplicate device status for a user
app.get("/api/user/duplicate-status", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const user = await User.findOne({ chatId });
  if (!user) return res.json({ exists: false, is_duplicate_device: false });
  res.json({
    chatId: user.chatId,
    is_duplicate_device: user.is_duplicate_device || false,
    device_blocked: user.device_blocked || false,
    can_earn_referral: !user.is_duplicate_device
  });
});

export default app;
