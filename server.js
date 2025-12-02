// server.js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ---------------------
// MONGO CONNECTION
// ---------------------
const MONGO_URI = process.env.MONGO_URI;
await mongoose.connect(MONGO_URI, {});

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
    referral_code: String, // user’s own code
    referred_by: String,   // code of inviter (set ONLY via /api/bot/refer)
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
    type: String, // credit / debit
    amount: Number,
    description: String,
    status: String, // success / pending / failed
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
    chatId: String,          // inviter chatId
    referral_code: String,   // inviter's code
    referred_users: [
      {
        user_id: String,     // referred user's chatId
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
    status: String, // completed / pending / failed
    initiated_at: Date,
    completed_at: Date,
    transaction_id: String,
    failure_reason: String
  })
);

// Helper – ensure wallet exists for a user
async function ensureWallet(chatId) {
  let wallet = await Wallet.findOne({ chatId });
  if (!wallet) wallet = await Wallet.create({ chatId });
  return wallet;
}

// ----------------------------------------------
// 1. USER API (NO REFERRAL LOGIC HERE)
// ----------------------------------------------
app.get("/api/user/info", async (req, res) => {
  const { chatId, username, avatar } = req.query;

  if (!chatId) return res.status(400).json({ error: "chatId required" });

  let user = await User.findOne({ chatId });

  if (!user) {
    const referralCode = Math.floor(100000 + Math.random() * 900000).toString();

    user = await User.create({
      chatId,
      username,
      avatar,
      referral_code: referralCode,
      // IMPORTANT: we do NOT set referred_by here
      // only /api/bot/refer can set that
    });

    // Create wallet automatically for new user
    await ensureWallet(chatId);
  } else {
    // Update basic data only
    user.username = username || user.username;
    user.avatar = avatar || user.avatar;
    await user.save();
  }

  res.json({
    user_id: user.chatId,
    username: user.username,
    avatar: user.avatar,
    created_at: user.created_at,
    status: user.status,
    referral_code: user.referral_code,
    referred_by: user.referred_by || null
  });
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
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  const tx = await Txn.find({ chatId })
    .sort({ timestamp: -1 })
    .skip(Number(offset))
    .limit(Number(limit));

  const total = await Txn.countDocuments({ chatId });

  res.json({
    transactions: tx.map(t => ({
      id: t._id,
      type: t.type,
      amount: t.amount.toFixed(2),
      description: t.description,
      status: t.status,
      timestamp: t.timestamp,
      metadata: t.metadata
    })),
    total
  });
});

// ----------------------------------------------
// 3. UPI (GET = create/update)
// ----------------------------------------------
app.get("/api/upi", async (req, res) => {
  const { chatId, vpa, bank_name } = req.query;

  if (!chatId) return res.status(400).json({ error: "chatId required" });

  let upi = await UPI.findOne({ chatId });

  if (!upi) {
    upi = await UPI.create({
      chatId,
      vpa,
      bank_name,
      is_verified: !!vpa,
      linked_at: vpa ? new Date() : null
    });
  } else {
    if (vpa) {
      upi.vpa = vpa;
      upi.is_verified = true;
      upi.linked_at = new Date();
    }
    if (bank_name) upi.bank_name = bank_name;
    await upi.save();
  }

  res.json({
    vpa: upi.vpa,
    is_verified: upi.is_verified,
    linked_at: upi.linked_at,
    bank_name: upi.bank_name
  });
});

// ----------------------------------------------
// 4. WITHDRAWAL
// ----------------------------------------------
app.post("/api/withdraw/initiate", async (req, res) => {
  const { chatId, amount, vpa } = req.body;

  if (!chatId || !amount || !vpa) {
    return res.status(400).json({ error: "chatId, amount, vpa required" });
  }

  const fee = 3.0;
  const net = Number(amount) - fee;

  const wd = await Withdraw.create({
    chatId,
    amount: Number(amount),
    vpa,
    fee,
    net_amount: net,
    status: "pending",
    initiated_at: new Date()
  });

  res.json({
    withdrawal_id: wd._id,
    amount: wd.amount.toFixed(2),
    fee: wd.fee.toFixed(2),
    net_amount: wd.net_amount.toFixed(2),
    estimated_time: "2-4 hours",
    status: wd.status
  });
});

app.get("/api/withdraw/history", async (req, res) => {
  const { chatId, limit = 10, offset = 0 } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  const data = await Withdraw.find({ chatId })
    .sort({ initiated_at: -1 })
    .skip(Number(offset))
    .limit(Number(limit));

  const total = await Withdraw.countDocuments({ chatId });

  res.json({
    withdrawals: data.map(w => ({
      id: w._id,
      amount: w.amount.toFixed(2),
      status: w.status,
      vpa: w.vpa,
      initiated_at: w.initiated_at,
      completed_at: w.completed_at,
      transaction_id: w.transaction_id,
      failure_reason: w.failure_reason
    })),
    total
  });
});

// ----------------------------------------------
// 5. REFERRAL INFO + LIST (READ ONLY)
// ----------------------------------------------
app.get("/api/referral", async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  const user = await User.findOne({ chatId });
  if (!user) return res.status(404).json({ error: "User not found" });

  const ref = await Referral.findOne({ chatId });

  res.json({
    code: user.referral_code,
    link: `https://t.me/winzoplay_bot?start=${user.referral_code}`, // change bot username as needed
    total_referrals: ref?.referred_users.length || 0,
    successful_referrals: ref?.referred_users.filter(x => x.is_active).length || 0,
    total_earned: (ref?.total_earned || 0).toFixed(2),
    pending_earned: (ref?.pending_earned || 0).toFixed(2),
    commission_per_referral: "3.00"
  });
});

app.get("/api/referral/users", async (req, res) => {
  const { chatId, limit = 20, offset = 0 } = req.query;
  if (!chatId) return res.status(400).json({ error: "chatId required" });

  const ref = await Referral.findOne({ chatId });

  const list =
    ref?.referred_users.slice(
      Number(offset),
      Number(offset) + Number(limit)
    ) || [];

  res.json({
    referrals: list.map(u => ({
      user_id: u.user_id,
      username: u.username,
      joined_at: u.joined_at,
      status: u.is_active ? "active" : "pending",
      earned_amount: u.earned_amount.toFixed(2),
      is_active: u.is_active
    })),
    total: ref?.referred_users.length || 0
  });
});

// ----------------------------------------------
// 6. BOT REFERRAL API (ONLY WAY TO CREATE REFERRALS)
// ----------------------------------------------
app.post("/api/bot/refer", async (req, res) => {
  try {
    const { chatId, username, avatar, ref } = req.body;

    if (!chatId) {
      return res.status(400).json({ success: false, error: "chatId missing" });
    }

    let user = await User.findOne({ chatId });

    // NEW USER coming from bot
    if (!user) {
      const referralCode = Math.floor(100000 + Math.random() * 900000).toString();

      user = await User.create({
        chatId,
        username,
        avatar,
        referral_code: referralCode,
        referred_by: ref || null
      });

      // Ensure wallet
      await ensureWallet(chatId);

      // Handle referral linking if ref present
      if (ref) {
        const inviter = await User.findOne({ referral_code: ref });

        if (inviter) {
          let refDoc = await Referral.findOne({ chatId: inviter.chatId });

          if (!refDoc) {
            refDoc = await Referral.create({
              chatId: inviter.chatId,
              referral_code: inviter.referral_code,
              referred_users: []
            });
          }

          refDoc.referred_users.push({
            user_id: chatId,
            username: username || "",
            joined_at: new Date(),
            earned_amount: 0,
            is_active: false
          });

          await refDoc.save();
        }
      }
    } else {
      // Existing user: we NEVER change referred_by here
      // Only set it once at creation time
      user.username = username || user.username;
      user.avatar = avatar || user.avatar;
      await user.save();
    }

    return res.json({
      success: true,
      referral_code: user.referral_code,
      referred_by: user.referred_by || null
    });
  } catch (err) {
    console.error("Bot refer error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

// ----------------------------------------------
export default app;
