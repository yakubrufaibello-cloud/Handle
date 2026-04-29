const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const APP_DIR = __dirname;
const DATA_FILE = path.join(__dirname, "backend", "data", "store.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const WALLET_KEYS = ["mainWallet", "wallet"];
const WALLET_LABELS = {
  mainWallet: "Main Wallet",
  wallet: "Wallet"
};
const WITHDRAWAL_METHODS = ["Cash App", "PayPal"];
const MARKET_IDS = ["bitcoin", "ethereum", "binancecoin", "solana", "ripple"];
const BTC_PER_USD = 0.00001357015;
const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const FIXED_WALLET_ADDRESS = "bc1qu4m7pty92dmwvgyx7unc5ph5f47sau6fgn9lln";

let marketCache = {
  fetchedAt: 0,
  data: null
};

app.use(cors());
app.use(express.json());
app.use(express.static(APP_DIR));

function ensureDb() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], sessions: [], transactions: [] }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  let changed = false;
  db.users = Array.isArray(db.users) ? db.users : [];
  if (!Array.isArray(db.sessions)) {
    db.sessions = [];
    changed = true;
  }
  if (!Array.isArray(db.transactions)) {
    db.transactions = [];
    changed = true;
  }

  db.transactions = db.transactions.map((transaction) => {
    const normalized = { ...transaction };
    if (!normalized.id) {
      normalized.id = crypto.randomUUID();
      changed = true;
    }
    if (!normalized.createdAt) {
      normalized.createdAt = normalized.timestamp || new Date().toISOString();
      changed = true;
    }
    if (!normalized.timestamp) {
      normalized.timestamp = normalized.createdAt;
      changed = true;
    }
    if (!normalized.receiptId) {
      normalized.receiptId = makeReceipt();
      changed = true;
    }
    if (!normalized.status) {
      normalized.status = "confirmed";
      changed = true;
    }
    if (!normalized.assetSymbol) {
      normalized.assetSymbol = normalized.type === "sell" ? "BTC" : normalized.type === "withdrawal" ? "USD" : "BTC";
      changed = true;
    }
    if (!normalized.assetName) {
      normalized.assetName = normalized.assetSymbol === "BTC" ? "Bitcoin" : normalized.assetSymbol === "ETH" ? "Ethereum" : normalized.assetSymbol === "BNB" ? "BNB" : normalized.assetSymbol === "USDT" ? "Tether" : normalized.assetSymbol === "USD" ? "US Dollar" : normalized.assetSymbol;
      changed = true;
    }
    if (typeof normalized.amount !== "number") {
      normalized.amount = Number(normalized.amount || 0);
      changed = true;
    }
    if (typeof normalized.fiatValue !== "number") {
      normalized.fiatValue = Number(normalized.fiatValue ?? normalized.amount ?? 0);
      changed = true;
    }
    if (typeof normalized.fee !== "number") {
      normalized.fee = Number(normalized.fee || 0);
      changed = true;
    }
    if (typeof normalized.confirmations !== "number") {
      normalized.confirmations = Number(normalized.confirmations || 0);
      changed = true;
    }
    if (!normalized.senderAddress) {
      normalized.senderAddress = normalized.fromLabel || "";
      changed = true;
    }
    if (!normalized.receiverAddress) {
      normalized.receiverAddress = normalized.toLabel || "";
      changed = true;
    }
    if (!normalized.txHash) {
      normalized.txHash = normalized.receiptId;
      changed = true;
    }
    if (!normalized.network) {
      normalized.network = normalized.type === "send" ? "Bitcoin" : normalized.type === "sell" ? "Bitcoin" : normalized.type === "withdrawal" ? String(normalized.toLabel || "Cash App") : "Bitcoin";
      changed = true;
    }
    return normalized;
  });

  db.users.forEach((user) => {
    if (ensureWalletAccounts(user)) {
      changed = true;
    }
    if (!user.cashWallets) {
      user.cashWallets = { mainWallet: 0, wallet: 0 };
      changed = true;
    }
    WALLET_KEYS.forEach((key) => {
      const normalized = Number(user.cashWallets[key] || 0);
      if (user.cashWallets[key] !== normalized) {
        user.cashWallets[key] = normalized;
        changed = true;
      }
    });
  });

  if (changed) {
    writeDb(db);
  }

  return db;
}

function writeDb(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validPassword(value) {
  return typeof value === "string" && value.length === 8;
}

function isWalletKey(value) {
  return WALLET_KEYS.includes(value);
}

function makeWalletAddress(seed, walletKey) {
  const hash = crypto.createHash("sha256").update(`${seed}:${walletKey}`).digest();
  let encoded = "";
  for (const byte of hash) {
    encoded += BECH32_CHARS[byte % BECH32_CHARS.length];
  }
  return `bc1${encoded.slice(0, 39)}`;
}

function ensureWalletAccounts(user) {
  let changed = false;

  if (!user.cashWallets) {
    user.cashWallets = { mainWallet: 0, wallet: 0 };
    changed = true;
  }

  if (!user.mainWallet || typeof user.mainWallet !== "object") {
    user.mainWallet = {};
    changed = true;
  }

  if (!user.wallet || typeof user.wallet !== "object") {
    user.wallet = {};
    changed = true;
  }

  if (!user.mainWallet.address) {
    user.mainWallet.address = makeWalletAddress(user.id || user.email || "bitvault", "mainWallet");
    changed = true;
  }

  if (user.wallet.address !== FIXED_WALLET_ADDRESS) {
    user.wallet.address = FIXED_WALLET_ADDRESS;
    changed = true;
  }

  const mainBalance = Number(user.cashWallets.mainWallet ?? user.mainWallet.balance ?? 0);
  const walletBalance = Number(user.cashWallets.wallet ?? user.wallet.balance ?? 0);

  if (user.cashWallets.mainWallet !== mainBalance) {
    user.cashWallets.mainWallet = mainBalance;
    changed = true;
  }
  if (user.cashWallets.wallet !== walletBalance) {
    user.cashWallets.wallet = walletBalance;
    changed = true;
  }
  if (user.mainWallet.balance !== mainBalance) {
    user.mainWallet.balance = mainBalance;
    changed = true;
  }
  if (user.wallet.balance !== walletBalance) {
    user.wallet.balance = walletBalance;
    changed = true;
  }

  return changed;
}

function publicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    cashWallets: user.cashWallets,
    mainWallet: user.mainWallet,
    wallet: user.wallet,
    createdAt: user.createdAt
  };
}

function walletCodeFor(user, walletKey) {
  const target = walletKey === "wallet" ? user.wallet : user.mainWallet;
  return target?.address || "";
}

function findUserByRecipient(db, recipientValue) {
  const value = normalizeEmail(recipientValue);
  if (!value) return null;

  const direct = db.users.find((user) => user.email === value);
  if (direct) return direct;

  const byCode = db.users.find((user) =>
    walletCodeFor(user, "mainWallet").toLowerCase() === value ||
    walletCodeFor(user, "wallet").toLowerCase() === value
  );
  return byCode || null;
}

function createSession(userId) {
  const db = readDb();
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions = db.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
  db.sessions.push({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
  writeDb(db);
  return token;
}

function getAuthUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return null;
  }

  const db = readDb();
  const session = db.sessions.find((item) => item.token === token);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    db.sessions = db.sessions.filter((item) => item.token !== token);
    writeDb(db);
    return null;
  }

  return db.users.find((user) => user.id === session.userId) || null;
}

function authRequired(req, res, next) {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ message: "Authentication required." });
  }
  req.user = user;
  return next();
}

function makeReceipt(prefix = "BV") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function makeTxHash() {
  return crypto.randomBytes(32).toString("hex");
}

function btcToUsd(btcAmount) {
  return Number((Number(btcAmount || 0) / BTC_PER_USD).toFixed(2));
}

function setWalletBalance(user, walletKey, balance) {
  const nextBalance = Number(Number(balance || 0).toFixed(2));
  if (!user.cashWallets) {
    user.cashWallets = { mainWallet: 0, wallet: 0 };
  }
  if (!user[walletKey] || typeof user[walletKey] !== "object") {
    user[walletKey] = {};
  }
  user.cashWallets[walletKey] = nextBalance;
  user[walletKey].balance = nextBalance;
  return nextBalance;
}

function moneyFormat(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}

function addTransaction(db, payload) {
  db.transactions.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    receiptId: payload.receiptId || makeReceipt(),
    ...payload
  });
}

function totalWalletSum(users, walletKey) {
  return users.reduce((sum, user) => sum + Number(user.cashWallets?.[walletKey] || 0), 0);
}

function normalizeMarkets(markets) {
  return markets.map((coin) => ({
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    image: coin.image,
    current_price: Number(coin.current_price || 0),
    price_change_percentage_24h: Number(coin.price_change_percentage_24h || 0),
    market_cap_rank: coin.market_cap_rank || null,
    high_24h: Number(coin.high_24h || 0),
    low_24h: Number(coin.low_24h || 0),
    last_updated: coin.last_updated || new Date().toISOString(),
    sparkline: Array.isArray(coin.sparkline_in_7d?.price) ? coin.sparkline_in_7d.price.map((value) => Number(value || 0)) : []
  }));
}

async function fetchMarkets(force = false) {
  if (!force && marketCache.data && Date.now() - marketCache.fetchedAt < 60 * 1000) {
    return marketCache.data;
  }

  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", MARKET_IDS.join(","));
  url.searchParams.set("price_change_percentage", "24h");
  url.searchParams.set("sparkline", "true");
  url.searchParams.set("precision", "2");
  url.searchParams.set("locale", "en");

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Market data request failed with status ${response.status}`);
  }

  const markets = normalizeMarkets(await response.json());
  marketCache = {
    fetchedAt: Date.now(),
    data: markets
  };
  return markets;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    walletLabels: WALLET_LABELS,
    withdrawalMethods: WITHDRAWAL_METHODS
  });
});

app.get("/api/markets", async (req, res) => {
  try {
    const markets = await fetchMarkets(Boolean(req.query.refresh));
    res.json({ markets, source: "coingecko", updatedAt: new Date(marketCache.fetchedAt).toISOString() });
  } catch (error) {
    if (marketCache.data) {
      return res.json({
        markets: marketCache.data,
        source: "cache",
        updatedAt: new Date(marketCache.fetchedAt).toISOString(),
        warning: "Live market fetch failed, showing cached data."
      });
    }

    return res.status(502).json({
      message: "Unable to load live market data."
    });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  const firstName = String(req.body?.firstName || "").trim();
  const lastName = String(req.body?.lastName || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!firstName || !lastName || !email || !validPassword(password)) {
    return res.status(400).json({ message: "Enter your full name, email, and an 8-character password." });
  }

  const db = readDb();
  if (db.users.some((user) => user.email === email)) {
    return res.status(409).json({ message: "This email already has a wallet. Login instead." });
  }

  const user = {
    id: crypto.randomUUID(),
    firstName,
    lastName,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    cashWallets: {
      mainWallet: 0,
      wallet: 0
    },
    mainWallet: {
      balance: 0,
      address: makeWalletAddress(email || "bitvault", "mainWallet")
    },
    wallet: {
      balance: 0,
      address: FIXED_WALLET_ADDRESS
    },
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  addTransaction(db, {
    type: "account_created",
    amount: 0,
    sourceWallet: "mainWallet",
    destinationWallet: "mainWallet",
    fromLabel: "BitVault",
    toUserId: user.id,
    toLabel: `${user.firstName} ${user.lastName}`,
    note: "BitVault account created with zero balances."
  });
  writeDb(db);

  const token = createSession(user.id);
  return res.status(201).json({
    message: "BitVault wallet created successfully.",
    token,
    user: publicUser(user)
  });
});

app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const db = readDb();
  const user = db.users.find((item) => item.email === email);

  if (!user) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  const token = createSession(user.id);
  return res.json({
    message: "Login successful.",
    token,
    user: publicUser(user)
  });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/wallet/transactions", authRequired, (req, res) => {
  const db = readDb();
  const transactions = db.transactions
    .filter((item) => (item.toUserId === req.user.id || item.fromUserId === req.user.id) && item.type !== "account_created")
    .sort((a, b) => new Date(b.timestamp || b.createdAt).getTime() - new Date(a.timestamp || a.createdAt).getTime());
  res.json({ transactions });
});

app.post("/api/wallet/send", authRequired, (req, res) => {
  const recipientValue = String(req.body?.recipientAddress || req.body?.recipientEmail || "");
  const sourceWallet = String(req.body?.sourceWallet || "");
  const destinationWallet = String(req.body?.destinationWallet || "mainWallet");
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "").trim();
  const fiatValue = btcToUsd(amount);
  const fee = 0.25;

  if (!isWalletKey(sourceWallet) || !isWalletKey(destinationWallet)) {
    return res.status(400).json({ message: "Invalid wallet selected." });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than zero." });
  }

  const db = readDb();
  const sender = db.users.find((item) => item.id === req.user.id);
  const recipient = findUserByRecipient(db, recipientValue);

  if (!recipient) {
    return res.status(404).json({ message: "Recipient not found." });
  }

  if (recipient.id === sender.id) {
    return res.status(400).json({ message: "You cannot send money to yourself." });
  }

  if (Number(sender.cashWallets[sourceWallet] || 0) < fiatValue + fee) {
    return res.status(400).json({ message: "Insufficient balance." });
  }

  setWalletBalance(sender, sourceWallet, Number((sender.cashWallets[sourceWallet] - fiatValue - fee).toFixed(2)));
  setWalletBalance(recipient, destinationWallet, Number((recipient.cashWallets[destinationWallet] + fiatValue).toFixed(2)));

  const receiptId = makeReceipt("SEND");
  addTransaction(db, {
    receiptId,
    type: "send",
    status: "confirmed",
    assetSymbol: "BTC",
    assetName: "Bitcoin",
    amount,
    fiatValue,
    fee,
    network: "Bitcoin",
    confirmations: 3,
    sourceWallet,
    destinationWallet,
    fromUserId: sender.id,
    fromLabel: `${sender.firstName} ${sender.lastName}`,
    senderAddress: walletCodeFor(sender, sourceWallet),
    toUserId: recipient.id,
    toLabel: `${recipient.firstName} ${recipient.lastName}`,
    receiverAddress: walletCodeFor(recipient, destinationWallet),
    txHash: makeTxHash(),
    timestamp: new Date().toISOString(),
    note: note || `${WALLET_LABELS[sourceWallet]} sent to ${recipient.email} into ${WALLET_LABELS[destinationWallet]}.`
  });
  writeDb(db);

  return res.json({
    message: "Transfer completed successfully.",
    receiptId
  });
});

app.post("/api/wallet/withdraw", authRequired, (req, res) => {
  const sourceWallet = String(req.body?.sourceWallet || "");
  const method = String(req.body?.method || "");
  const destination = String(req.body?.destination || "").trim();
  const amount = Number(req.body?.amount);
  const fee = 0.25;

  if (sourceWallet !== "mainWallet") {
    return res.status(400).json({ message: "Withdrawals can only come from Main Wallet." });
  }

  if (!WITHDRAWAL_METHODS.includes(method)) {
    return res.status(400).json({ message: "Invalid withdrawal method." });
  }

  if (!destination) {
    return res.status(400).json({ message: "Enter your Cash App or PayPal destination." });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than zero." });
  }

  const db = readDb();
  const user = db.users.find((item) => item.id === req.user.id);

  if (Number(user.cashWallets[sourceWallet] || 0) < amount + fee) {
    return res.status(400).json({ message: "Insufficient balance." });
  }

  setWalletBalance(user, sourceWallet, Number((user.cashWallets[sourceWallet] - amount - fee).toFixed(2)));
  const receiptId = makeReceipt("WD");
  addTransaction(db, {
    receiptId,
    type: "withdrawal",
    status: "pending",
    assetSymbol: "USD",
    assetName: "US Dollar",
    amount,
    fiatValue: amount,
    fee,
    network: method,
    confirmations: 0,
    sourceWallet,
    destinationWallet: null,
    fromUserId: user.id,
    fromLabel: `${user.firstName} ${user.lastName}`,
    senderAddress: walletCodeFor(user, sourceWallet),
    receiverAddress: destination,
    txHash: makeTxHash(),
    timestamp: new Date().toISOString(),
    toLabel: `${method} ${destination}`,
    note: `Withdrawal requested from ${WALLET_LABELS[sourceWallet]} to ${method}.`
  });
  writeDb(db);

  return res.json({
    message: `Withdrawal queued to ${method}.`,
    receiptId
  });
});

app.post("/api/wallet/sell", authRequired, async (req, res) => {
  const coinId = String(req.body?.coinId || "").trim();
  const amount = Number(req.body?.amount);
  const wallet = String(req.body?.wallet || "");

  if (wallet !== "wallet") {
    return res.status(400).json({ message: "Crypto sells must come from Wallet." });
  }

  if (!coinId) {
    return res.status(400).json({ message: "Select a coin to sell." });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than zero." });
  }

  try {
    const markets = await fetchMarkets();
    const coin = markets.find((item) => item.id === coinId);

    if (!coin) {
      return res.status(400).json({ message: "Selected coin is not available." });
    }

    const usdValue = Number((Number(amount) * Number(coin.current_price || 0)).toFixed(2));
    const db = readDb();
    const user = db.users.find((item) => item.id === req.user.id);

    if (Number(user.cashWallets.wallet || 0) < usdValue) {
      return res.status(400).json({ message: "Insufficient Wallet balance to sell this amount." });
    }

    setWalletBalance(user, "wallet", Number((user.cashWallets.wallet - usdValue).toFixed(2)));
    setWalletBalance(user, "mainWallet", Number((user.cashWallets.mainWallet + usdValue).toFixed(2)));

    const receiptId = makeReceipt("SELL");
    addTransaction(db, {
      receiptId,
      type: "sell",
      status: "confirmed",
      assetSymbol: coin.symbol.toUpperCase(),
      assetName: coin.name,
      amount,
      fiatValue: usdValue,
      fee: 0.25,
      network: "Bitcoin",
      confirmations: 3,
      sourceWallet: "wallet",
      destinationWallet: "mainWallet",
      fromUserId: user.id,
      fromLabel: `${user.firstName} ${user.lastName}`,
      senderAddress: walletCodeFor(user, "wallet"),
      toUserId: user.id,
      toLabel: `${user.firstName} ${user.lastName}`,
      receiverAddress: walletCodeFor(user, "mainWallet"),
      txHash: makeTxHash(),
      timestamp: new Date().toISOString(),
      note: `Sold ${amount} ${coin.symbol.toUpperCase()} at ${moneyFormat(coin.current_price)} into Main Wallet.`
    });
    writeDb(db);

    return res.json({
      message: `Sold ${amount} ${coin.symbol.toUpperCase()} for ${moneyFormat(usdValue)}.`,
      receiptId
    });
  } catch (error) {
    if (marketCache.data) {
      return res.status(502).json({ message: "Unable to sell right now. Live prices are unavailable." });
    }
    return res.status(502).json({ message: "Unable to sell right now." });
  }
});

app.get("/api/admin/overview", (req, res) => {
  const db = readDb();
  res.json({
    totals: {
      totalUsers: db.users.length,
      mainWallet: Number(totalWalletSum(db.users, "mainWallet").toFixed(2)),
      wallet: Number(totalWalletSum(db.users, "wallet").toFixed(2))
    }
  });
});

app.get("/api/admin/users", (req, res) => {
  const db = readDb();
  const users = db.users
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(publicUser);
  res.json({ users });
});

app.post("/api/admin/users/:id/fund", (req, res) => {
  const wallet = String(req.body?.wallet || "");
  const action = String(req.body?.action || "");
  const amount = Number(req.body?.amount);
  const db = readDb();
  const user = db.users.find((item) => item.id === req.params.id);

  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  if (!isWalletKey(wallet)) {
    return res.status(400).json({ message: "Invalid wallet selected." });
  }

  if (!["add", "deduct"].includes(action)) {
    return res.status(400).json({ message: "Invalid action." });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than zero." });
  }

  const currentBalance = Number(user.cashWallets[wallet] || 0);
  const nextBalance = action === "add" ? currentBalance + amount : currentBalance - amount;

  if (nextBalance < 0) {
    return res.status(400).json({ message: "Cannot deduct below zero." });
  }

  setWalletBalance(user, wallet, nextBalance);
  const receiptId = makeReceipt("ADM");
  addTransaction(db, {
    receiptId,
    type: action === "add" ? "admin_credit" : "admin_deduction",
    status: "confirmed",
    assetSymbol: "USD",
    assetName: "US Dollar",
    amount,
    fiatValue: amount,
    fee: 0,
    network: "BitVault Admin",
    confirmations: 1,
    sourceWallet: action === "add" ? null : wallet,
    destinationWallet: action === "add" ? wallet : null,
    fromUserId: action === "deduct" ? user.id : null,
    fromLabel: action === "add" ? "BitVault Admin" : `${user.firstName} ${user.lastName}`,
    senderAddress: action === "add" ? "BitVault Admin" : walletCodeFor(user, wallet),
    toUserId: action === "add" ? user.id : null,
    toLabel: action === "add" ? `${user.firstName} ${user.lastName}` : "BitVault Admin",
    receiverAddress: action === "add" ? walletCodeFor(user, wallet) : "BitVault Admin",
    txHash: makeTxHash(),
    timestamp: new Date().toISOString(),
    note: `${action === "add" ? "Added" : "Deducted"} funds in ${WALLET_LABELS[wallet]}.`
  });
  writeDb(db);

  return res.json({
    message: `${WALLET_LABELS[wallet]} ${action === "add" ? "credited" : "deducted"} successfully.`,
    receiptId,
    user: publicUser(user)
  });
});

app.get("/api/admin/transactions", (req, res) => {
  const db = readDb();
  const transactions = db.transactions
    .slice()
    .filter((item) => item.type !== "account_created")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ transactions });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(APP_DIR, "admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(APP_DIR, "index.html"));
});

app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(APP_DIR, "index.html"));
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  process.exit(1);
});

try {
  readDb();
  const server = app.listen(PORT, HOST, () => {
    console.log(`Server running on port ${PORT}`);
  });

  server.on("error", (error) => {
    console.error("Server failed to start:", error);
    process.exit(1);
  });
} catch (error) {
  console.error("Startup failed:", error);
  process.exit(1);
}

module.exports = {
  app
};
