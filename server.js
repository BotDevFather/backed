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
    referral_code: String,
    referred_by: String,
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
    failure_reason: String
  })
);

// Helper Function
async function ensureWallet(chatId) {
  let wallet = await Wallet.findOne({ chatId });
  if (!wallet) wallet = await Wallet.create({ chatId });
  return wallet;
}

const BOT_TOKEN = "8337510534:AAEh1f4Nwqz0SBtLoQjsb3Z6Zygj69wPZag";
const ADMIN_CHAT_ID = "REPLACE_WITH_ADMIN_CHAT_ID"; // your telegram id

async function notifyAdmin(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ADMIN_CHAT_ID,
      text,
      parse_mode: "HTML"
    })
  });
}

async function notifyUser(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
  });
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
      referral_code: referralCode
    });

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

  const tx = await Txn.find({ chatId })
    .sort({ timestamp: -1 })
    .skip(Number(offset))
    .limit(Number(limit));

  const total = await Txn.countDocuments({ chatId });

  res.json({
    transactions: tx,
    total
  });
});

// ----------------------------------------------
// 3. UPI
// ----------------------------------------------
app.get("/api/upi", async (req, res) => {
  const { chatId, vpa, bank_name } = req.query;

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

  res.json(upi);
});

// ----------------------------------------------
// 4. WITHDRAWAL (DEDUCT BALANCE + NOTIFY ADMIN)
// ----------------------------------------------
app.post("/api/withdraw/initiate", async (req, res) => {
  const { chatId, amount, vpa } = req.body;

  if (!chatId || !amount || !vpa) {
    return res.status(400).json({ error: "chatId, amount & vpa required" });
  }

  const wallet = await ensureWallet(chatId);

  const withdrawAmount = Number(amount);
  const fee = 3.0;
  const totalDebit = withdrawAmount; // user entered amount includes fee built-in
  const net = withdrawAmount - fee;

  // CHECK IF USER HAS ENOUGH BALANCE
  if (wallet.balance < totalDebit) {
    return res.json({ error: "Insufficient balance" });
  }

  // DEDUCT BALANCE
  wallet.balance -= totalDebit;
  await wallet.save();

  // CREATE WITHDRAWAL RECORD
  const wd = await Withdraw.create({
    chatId,
    amount: withdrawAmount,
    vpa,
    fee,
    net_amount: net,
    status: "pending",
    initiated_at: new Date()
  });

  // ADD TRANSACTION FOR USER
  await Txn.create({
    chatId,
    type: "debit",
    amount: withdrawAmount,
    description: "Withdrawal Initiated",
    status: "pending",
    metadata: { withdrawal_id: wd._id }
  });

  // NOTIFY USER
  await notifyUser(
    chatId,
    `💸 <b>Withdrawal Request Submitted!</b>\n\nAmount: ₹${withdrawAmount}\nVPA: ${vpa}\nStatus: Pending`
  );

  // NOTIFY ADMIN
  await notifyAdmin(
    `🛑 <b>New Withdrawal Request</b>\n\nUser: <code>${chatId}</code>\nAmount: ₹${withdrawAmount}\nVPA: ${vpa}\nWithdraw ID: <code>${wd._id}</code>`
  );

  res.json({
    withdrawal_id: wd._id,
    amount: withdrawAmount,
    fee,
    net_amount: net,
    status: "pending",
    estimated_time: "2-4 hours"
  });
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
    commission_per_referral: "3.00"
  });
});

// ----------------------------------------------
// 6. REFERRAL USER LIST
// ----------------------------------------------
app.get("/api/referral/users", async (req, res) => {
  const { chatId } = req.query;

  const ref = await Referral.findOne({ chatId });
  res.json({
    referrals: ref?.referred_users || [],
    total: ref?.referred_users.length || 0
  });
});

// ----------------------------------------------
// 7. BOT REFERRAL (POST + GET SUPPORTED)
// ----------------------------------------------
app.all("/api/bot/refer", async (req, res) => {
  try {
    const data = req.method === "GET" ? req.query : req.body;

    const { chatId, username, avatar, ref } = data;

    if (!chatId)
      return res.status(400).json({ success: false, error: "chatId required" });

    let user = await User.findOne({ chatId });

    // NEW USER
    if (!user) {
      const referralCode = Math.floor(100000 + Math.random() * 900000).toString();

      user = await User.create({
        chatId,
        username,
        avatar,
        referral_code: referralCode,
        referred_by: ref || null
      });

      await ensureWallet(chatId);

      // Apply referral reward
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

          // Add referral entry
          refDoc.referred_users.push({
            user_id: chatId,
            username: username || "",
            joined_at: new Date(),
            earned_amount: 3,
            is_active: true
          });

          refDoc.total_earned += 3;
          await refDoc.save();

          // Credit +3 to inviter wallet
          let inviterWallet = await ensureWallet(inviter.chatId);
          inviterWallet.balance += 3;
          await inviterWallet.save();

          // Add transaction
          await Txn.create({
            chatId: inviter.chatId,
            type: "credit",
            amount: 3,
            description: "Referral Reward",
            status: "success",
            metadata: { referred_user: chatId }
          });
        }
      }
    } else {
      // Update username/avatar only
      user.username = username || user.username;
      user.avatar = avatar || user.avatar;
      await user.save();
    }

    res.json({
      success: true,
      referral_code: user.referral_code,
      referred_by: user.referred_by
    });
  } catch (err) {
    console.error("Referral error:", err);
    res.json({ success: false });
  }
});


// ----------------------------------------------
export default app;
