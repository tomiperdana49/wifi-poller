'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');

const apiRouter = require('./src/routes/api');
const { startBroadcaster } = require('./src/broadcaster');

const PORT = process.env.PORT || 3000;

const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME;
const DASHBOARD_PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD_HASH || !SESSION_SECRET) {
  console.error(
    'FATAL: DASHBOARD_USERNAME, DASHBOARD_PASSWORD_HASH, dan SESSION_SECRET wajib diisi di .env. '
    + 'Lihat dashboard/.env.example untuk cara generate hash password.'
  );
  process.exit(1);
}

const app = express();

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000, // 12 jam
  },
});

app.use(sessionMiddleware);
app.use(express.urlencoded({ extended: false }));

// ---- Login/logout: TIDAK melewati requireAuth di bawah ----
app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === DASHBOARD_USERNAME;
  // Tetap panggil bcrypt.compare walau username salah (pakai hash asli
  // kalau ada), supaya waktu respons tidak membocorkan username mana
  // yang valid lewat timing.
  const validPass = await bcrypt.compare(password || '', DASHBOARD_PASSWORD_HASH);

  if (!validUser || !validPass) {
    return res.redirect('/login?error=1');
  }

  req.session.authenticated = true;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Semua route di bawah ini wajib login ----
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// WebSocket tidak lewat middleware Express biasa -- session-nya dicek
// manual di sini saat request upgrade, supaya /ws ikut terproteksi login
// (bukan cuma halaman & /api).
server.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  sessionMiddleware(request, {}, () => {
    if (!request.session || !request.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Buang koneksi mati tiap 30 detik supaya wss.clients tidak menumpuk zombie
// kalau browser client hilang tanpa close handshake yang bersih.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

startBroadcaster(broadcast);

server.listen(PORT, () => {
  console.log(`wifi-poller dashboard listening on :${PORT}`);
});
