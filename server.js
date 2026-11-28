const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { electLeader, canJoinRoom, roleFor } = require('./room-leadership');

if (!process.env.DATABASE_URL) {
  console.error('ERRO: configure DATABASE_URL com a conexão do PostgreSQL antes de iniciar.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('ERRO: configure SESSION_SECRET com uma chave longa e aleatória.');
  process.exit(1);
}
let configuredPublicUrl = null;
if (process.env.PUBLIC_URL) {
  try {
    const parsedPublicUrl = new URL(process.env.PUBLIC_URL);
    if (parsedPublicUrl.protocol !== 'https:' || parsedPublicUrl.username || parsedPublicUrl.password) throw new Error('URL pública inválida');
    configuredPublicUrl = parsedPublicUrl.origin;
  } catch { console.error('ERRO: PUBLIC_URL precisa ser uma URL HTTPS válida, sem credenciais.'); process.exit(1); }
}
if (process.env.NODE_ENV === 'production' && !configuredPublicUrl) {
  console.error('ERRO: configure PUBLIC_URL com o endereço HTTPS público do site.');
  process.exit(1);
}
function publicBaseUrl(req) { return configuredPublicUrl || `${req.protocol}://${req.get('host')}`; }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : false
});

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024,
  pingTimeout: 20000,
  pingInterval: 25000
});
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://s.ytimg.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      fontSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(express.json({ limit: '10kb' }));
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET não definido: usando chave temporária apenas para desenvolvimento.');
const sessionMiddleware = session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'watchparty.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(express.static('public', { etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }
});
const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas alterações de perfil. Tente novamente mais tarde.' }
});
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api/profile', profileLimiter);
app.use('/api/friends', rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/rooms', rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', (req,res,next) => {
  if (!['POST','PATCH','PUT','DELETE'].includes(req.method)) return next();
  const origin=req.get('origin');
  if (!origin) return res.status(403).json({error:'Origem ausente. Atualize a página e tente novamente.'});
  try { const expectedOrigin = `${req.protocol}://${req.get('host')}`; if (new URL(origin).origin.toLowerCase() !== expectedOrigin.toLowerCase()) return res.status(403).json({error:'Origem da solicitação não permitida.'}); } catch { return res.status(403).json({error:'Origem inválida.'}); }
  next();
});
app.use('/api/rooms', rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas salas criadas. Tente novamente mais tarde.' } }));

async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name VARCHAR(30) NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS watch_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_code VARCHAR(8) NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS watch_history_user_idx ON watch_history(user_id, joined_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    code VARCHAR(8) PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT,
    invite_token TEXT NOT NULL UNIQUE,
    max_members INTEGER NOT NULL DEFAULT 10 CHECK (max_members BETWEEN 2 AND 30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms(owner_id, created_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGSERIAL PRIMARY KEY, sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(sender_id, receiver_id), CHECK(sender_id <> receiver_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(blocker_id, blocked_id), CHECK(blocker_id <> blocked_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(40) NOT NULL, message VARCHAR(240) NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC)');
  await pool.query("CREATE INDEX IF NOT EXISTS friend_requests_receiver_pending_idx ON friend_requests(receiver_id, created_at DESC) WHERE status = 'pending'");
  await pool.query("CREATE INDEX IF NOT EXISTS friend_requests_sender_pending_idx ON friend_requests(sender_id, created_at DESC) WHERE status = 'pending'");
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  next();
}

function isValidUserId(value) {
  if (!/^[1-9]\d{0,18}$/.test(String(value || ''))) return false;
  try { return BigInt(value) <= 9223372036854775807n; } catch { return false; }
}

function establishSession(req, res, user, status = 200) {
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Não foi possível iniciar sua sessão.' });
    req.session.userId = user.id;
    req.session.user = user;
    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: 'Não foi possível salvar sua sessão.' });
      res.status(status).json({ user });
    });
  });
}

app.post('/api/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim().slice(0, 30);
    const avatarUrl = String(req.body.avatarUrl || '').trim().slice(0, 500);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Digite um e-mail válido.' });
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres e no máximo 72 bytes.' });
    if (!displayName) return res.status(400).json({ error: 'Informe seu nome de perfil.' });
    if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return res.status(400).json({ error: 'A foto precisa ser um link HTTPS.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users(email,password_hash,display_name,avatar_url) VALUES($1,$2,$3,$4) RETURNING id,email,display_name,avatar_url',
      [email, passwordHash, displayName, avatarUrl]
    );
    establishSession(req, res, result.rows[0], 201);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    console.error(err); res.status(500).json({ error: 'Não foi possível criar sua conta.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT id,email,password_hash,display_name,avatar_url FROM users WHERE email=$1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    establishSession(req, res, { id: user.id, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Não foi possível entrar.' }); }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id,email,display_name,avatar_url FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows[0]) return req.session.destroy(() => res.status(401).json({ error: 'Conta não encontrada.' }));
    req.session.user = result.rows[0];
    res.json({ user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Não foi possível carregar sua conta.' }); }
});

app.post('/api/logout', requireAuth, (req, res) => {
  const userId = String(req.session.userId);
  req.session.destroy(async err => {
    if (err) return res.status(500).json({ error: 'Não foi possível encerrar a sessão.' });
    res.clearCookie('watchparty.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    try {
      const sockets = await io.fetchSockets();
      sockets.filter(client => String(client.user && client.user.id) === userId).forEach(client => client.disconnect(true));
    } catch (socketError) { console.error('Falha ao encerrar conexões da conta:', socketError); }
    res.json({ ok: true });
  });
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
  const displayName = String(req.body.displayName || '').trim().slice(0, 30);
  const avatarUrl = String(req.body.avatarUrl || '').trim().slice(0, 500);
  if (!displayName) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return res.status(400).json({ error: 'A foto precisa ser um link HTTPS.' });
  const result = await pool.query('UPDATE users SET display_name=$1, avatar_url=$2 WHERE id=$3 RETURNING id,email,display_name,avatar_url', [displayName, avatarUrl, req.session.userId]);
  req.session.user = result.rows[0]; res.json({ user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Não foi possível atualizar seu perfil.' }); }
});

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT room_code, joined_at FROM watch_history WHERE user_id=$1 ORDER BY joined_at DESC LIMIT 30', [req.session.userId]);
    res.json({ history: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Não foi possível carregar o histórico.' }); }
});



function notifyUser(userId, type, message, data = {}) {
  return pool.query('INSERT INTO notifications(user_id,type,message,data) VALUES($1,$2,$3,$4)', [userId,type,message,JSON.stringify(data)])
    .then(() => io.to(`user:${userId}`).emit('notification:new', { type, message, data }))
    .catch(err => console.error('Falha ao criar notificação:', err));
}
app.get('/api/friends/search', requireAuth, async (req,res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0,80);
    if (q.length < 2) return res.json({ users: [] });
    const result = await pool.query(`SELECT id,display_name,avatar_url FROM users u WHERE id<>$1 AND (email ILIKE $2 OR display_name ILIKE $2)
      AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$1))
      AND NOT EXISTS(SELECT 1 FROM friend_requests f WHERE ((f.sender_id=$1 AND f.receiver_id=u.id) OR (f.sender_id=u.id AND f.receiver_id=$1)) AND f.status='accepted')
      ORDER BY display_name LIMIT 10`, [req.session.userId, `%${q}%`]);
    res.json({users:result.rows});
  } catch(err) { console.error(err); res.status(500).json({error:'Não foi possível buscar usuários.'}); }
});
app.get('/api/friends', requireAuth, async (req,res) => {
  try {
    const id=req.session.userId;
    const [friends,incoming,outgoing]=await Promise.all([
      pool.query(`SELECT u.id,u.display_name,u.avatar_url FROM friend_requests f JOIN users u ON u.id=CASE WHEN f.sender_id=$1 THEN f.receiver_id ELSE f.sender_id END WHERE (f.sender_id=$1 OR f.receiver_id=$1) AND f.status='accepted' ORDER BY u.display_name`,[id]),
      pool.query(`SELECT f.id AS request_id,u.id AS user_id,u.display_name,u.avatar_url FROM friend_requests f JOIN users u ON u.id=f.sender_id WHERE f.receiver_id=$1 AND f.status='pending' ORDER BY f.created_at DESC`,[id]),
      pool.query(`SELECT f.id AS request_id,u.id AS user_id,u.display_name FROM friend_requests f JOIN users u ON u.id=f.receiver_id WHERE f.sender_id=$1 AND f.status='pending' ORDER BY f.created_at DESC`,[id])
    ]);
    res.json({friends:friends.rows,incoming:incoming.rows,outgoing:outgoing.rows});
  } catch(err) { console.error(err); res.status(500).json({error:'Não foi possível carregar amigos.'}); }
});
app.post('/api/friends/request', requireAuth, async (req,res) => {
  const receiver=String(req.body.userId||''); const sender=String(req.session.userId);
  if(!isValidUserId(receiver)||receiver===sender) return res.status(400).json({error:'Usuário inválido.'});
  const targetUser=await pool.query('SELECT 1 FROM users WHERE id=$1',[receiver]);
  if(!targetUser.rowCount) return res.status(404).json({error:'Usuário não encontrado.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const blocked=await client.query('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',[sender,receiver]);
    if(blocked.rowCount) { await client.query('ROLLBACK'); return res.status(403).json({error:'Não é possível enviar solicitação para este usuário.'}); }
    const pairKey = [BigInt(sender), BigInt(receiver)].sort((a,b)=>a<b?-1:1).join(':');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[pairKey]);
    const existing=await client.query("SELECT id,sender_id,receiver_id,status FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) FOR UPDATE",[sender,receiver]);
    if(existing.rows.some(x=>x.status==='accepted')) { await client.query('ROLLBACK'); return res.status(409).json({error:'Vocês já são amigos.'}); }
    const pending=existing.rows.find(x=>x.status==='pending');
    if(pending) { await client.query('ROLLBACK'); return res.status(409).json({error:'Já existe uma solicitação pendente entre vocês.'}); }
    if(existing.rows.length > 1) {
      await client.query('DELETE FROM friend_requests WHERE id = ANY($1::bigint[])',[existing.rows.map(row=>row.id)]);
      await client.query("INSERT INTO friend_requests(sender_id,receiver_id) VALUES($1,$2)",[sender,receiver]);
    } else if(existing.rows.length === 1) {
      await client.query("UPDATE friend_requests SET sender_id=$1,receiver_id=$2,status='pending',created_at=NOW() WHERE id=$3",[sender,receiver,existing.rows[0].id]);
    } else {
      await client.query("INSERT INTO friend_requests(sender_id,receiver_id) VALUES($1,$2)",[sender,receiver]);
    }
    await client.query('COMMIT');
    const who=await pool.query('SELECT display_name FROM users WHERE id=$1',[sender]);
    await notifyUser(receiver,'friend_request',`${who.rows[0]?.display_name||'Alguém'} enviou uma solicitação de amizade.`,{userId:sender});
    res.status(201).json({ok:true});
  } catch(err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({error:'Não foi possível enviar a solicitação.'}); }
  finally { client.release(); }
});
app.post('/api/friends/:id/respond', requireAuth, async (req,res) => {
  if(!isValidUserId(req.params.id)) return res.status(400).json({error:'Solicitação inválida.'});
  try {
    const accept=req.body.accept===true;
    const result=await pool.query("UPDATE friend_requests SET status=$1 WHERE id=$2 AND receiver_id=$3 AND status='pending' RETURNING sender_id",[accept?'accepted':'rejected',req.params.id,req.session.userId]);
    if(!result.rowCount) return res.status(404).json({error:'Solicitação não encontrada.'});
    if(accept) { const who=await pool.query('SELECT display_name FROM users WHERE id=$1',[req.session.userId]); await notifyUser(result.rows[0].sender_id,'friend_accepted',`${who.rows[0]?.display_name||'Alguém'} aceitou sua solicitação.`,{}); }
    res.json({ok:true});
  } catch(err) { console.error(err); res.status(500).json({error:'Não foi possível responder à solicitação.'}); }
});
app.delete('/api/friends/:userId', requireAuth, async (req,res) => {
  if(!isValidUserId(req.params.userId)) return res.status(400).json({error:'Usuário inválido.'});
  try { await pool.query("DELETE FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))",[req.session.userId,req.params.userId]); res.json({ok:true}); }
  catch(err) { console.error(err); res.status(500).json({error:'Não foi possível remover amizade.'}); }
});
app.post('/api/blocks/:userId', requireAuth, async (req,res) => {
  const target=String(req.params.userId||'');
  if(!isValidUserId(target)||target===String(req.session.userId)) return res.status(400).json({error:'Usuário inválido.'});
  try {
    const exists=await pool.query('SELECT 1 FROM users WHERE id=$1',[target]);
    if(!exists.rowCount) return res.status(404).json({error:'Usuário não encontrado.'});
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.session.userId,target]);
    await pool.query("DELETE FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)",[req.session.userId,target]);
    res.json({ok:true});
  } catch(err) { console.error(err); res.status(500).json({error:'Não foi possível bloquear usuário.'}); }
});
app.post('/api/rooms/:code/invite/:friendId', requireAuth, async (req,res) => {
  try {
    const code=String(req.params.code||'').trim().toUpperCase();
    const friendId=String(req.params.friendId||'');
    if(!/^[A-Z0-9]{3,8}$/.test(code)||!isValidUserId(friendId)||friendId===String(req.session.userId))
      return res.status(400).json({error:'Convite inválido.'});
    const friendship=await pool.query("SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))",[req.session.userId,friendId]);
    if(!friendship.rowCount) return res.status(403).json({error:'Você só pode convidar amigos adicionados.'});
    const blocked=await pool.query('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',[req.session.userId,friendId]);
    if(blocked.rowCount) return res.status(403).json({error:'Não é possível convidar este usuário.'});
    const roomResult=await pool.query('SELECT code,owner_id,is_private,invite_token FROM rooms WHERE code=$1',[code]);
    const roomData=roomResult.rows[0];
    if(!roomData) return res.status(404).json({error:'Sala não encontrada.'});
    let authorized=String(roomData.owner_id)===String(req.session.userId);
    if(!authorized) {
      const active=await io.in(code).fetchSockets();
      authorized=active.some(client=>String(client.user?.id)===String(req.session.userId));
    }
    if(!authorized) return res.status(403).json({error:'Entre na sala antes de convidar alguém.'});
    const inviter=await pool.query('SELECT display_name FROM users WHERE id=$1',[req.session.userId]);
    const inviteUrl=`${publicBaseUrl(req)}/?room=${roomData.code}${roomData.is_private?`&invite=${roomData.invite_token}`:''}`;
    await notifyUser(friendId,'room_invite',`${inviter.rows[0]?.display_name||'Um amigo'} convidou você para a sala ${roomData.code}.`,{roomCode:roomData.code,inviteUrl});
    res.status(201).json({ok:true});
  } catch(err) { console.error(err); res.status(500).json({error:'Não foi possível enviar o convite.'}); }
});

app.get('/api/notifications', requireAuth, async (req,res) => {
  try { const result=await pool.query('SELECT id,type,message,data,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',[req.session.userId]); res.json({notifications:result.rows}); }
  catch(err) { console.error(err); res.status(500).json({error:'Não foi possível carregar notificações.'}); }
});
app.post('/api/notifications/read', requireAuth, async (req,res) => {
  try { await pool.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL',[req.session.userId]); res.json({ok:true}); }
  catch(err) { console.error(err); res.status(500).json({error:'Não foi possível atualizar notificações.'}); }
});

function makeRoomCode() { return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7); }
app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const isPrivate = req.body.isPrivate === true;
    const password = String(req.body.password || '');
    const maxMembers = Number(req.body.maxMembers || 10);
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 30)
      return res.status(400).json({ error: 'O limite precisa ser entre 2 e 30 participantes.' });
    if (isPrivate && (password.length < 4 || Buffer.byteLength(password, 'utf8') > 72))
      return res.status(400).json({ error: 'A senha da sala privada precisa ter entre 4 e 72 bytes.' });
    let code, inviteToken, result;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = makeRoomCode(); inviteToken = crypto.randomBytes(24).toString('hex');
      try {
        const passwordHash = isPrivate ? await bcrypt.hash(password, 10) : null;
        result = await pool.query(
          'INSERT INTO rooms(code,owner_id,is_private,password_hash,invite_token,max_members) VALUES($1,$2,$3,$4,$5,$6) RETURNING code,is_private,max_members,invite_token',
          [code, req.session.userId, isPrivate, passwordHash, inviteToken, maxMembers]
        );
        break;
      } catch (err) { if (err.code !== '23505' || attempt === 4) throw err; }
    }
    const roomData = result.rows[0];
    res.status(201).json({ room: { code: roomData.code, isPrivate: roomData.is_private, maxMembers: roomData.max_members, inviteUrl: `${publicBaseUrl(req)}/?room=${roomData.code}&invite=${roomData.invite_token}` } });
  } catch (err) { console.error('Falha ao criar sala:', err); res.status(500).json({ error: 'Não foi possível criar a sala.' }); }
});


const rooms = Object.create(null);
const MAX_ROOMS = 500;
const MAX_ROOM_MEMBERS = 30;
function allowSocketEvent(socket, event, limit, windowMs) {
  const now = Date.now();
  socket.eventWindows ||= Object.create(null);
  const bucket = socket.eventWindows[event] || (socket.eventWindows[event] = []);
  while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
  if (bucket.length >= limit) return false;
  bucket.push(now);
  return true;
}
function publicRoomState(r) {
  return { videoId: r.videoId, playing: r.playing, time: r.time, updatedAt: r.updatedAt };
}

const room = id => (rooms[id] ??= {
  videoId: null,
  playing: false,
  time: 0,
  updatedAt: Date.now(),
  users: 0,
  leaderId: null,
  ownerUserId: null,
  maxMembers: 10,
  isPrivate: false,
  members: new Map(),
  typing: new Set()
});

function publishPresence(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  const people = [...r.members.entries()].map(([id, member]) => ({ id, name: member.name, isCreator: id === r.leaderId, isLeader: id === r.leaderId, isOwner: member.isOwner }));
  io.to(roomId).emit('presence', people);
}

function publishTyping(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  const names = [...r.typing].map(id => r.members.get(id)?.name).filter(Boolean);
  io.to(roomId).emit('typing', names);
}

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error('Faça login para entrar em uma sala.'));
  socket.user = socket.request.session.user;
  next();
});

io.on('connection', socket => {
  socket.join(`user:${socket.user.id}`);
  let roomId = null;
  let historyId = null;
  let joiningRoom = false;
  let name = socket.user.display_name;

  socket.on('join', async payload => {
    if (roomId || joiningRoom || !allowSocketEvent(socket, 'join', 5, 60 * 1000)) return;
    const requestedRoom = String(payload && payload.room || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(requestedRoom)) {
      socket.emit('room:join-error', 'Código de sala inválido. Use de 3 a 8 letras ou números.'); return;
    }
    joiningRoom = true;
    try {
      const lookup = await pool.query('SELECT code,owner_id,is_private,password_hash,invite_token,max_members FROM rooms WHERE code=$1', [requestedRoom]);
      const settings = lookup.rows[0];
      if (!settings) { joiningRoom = false; socket.emit('room:join-error', 'Sala não encontrada. Confira o código ou crie uma nova sala.'); return; }
      const invite = String(payload && payload.invite || '');
      const hasInvite = /^[a-f0-9]{48}$/i.test(invite) && crypto.timingSafeEqual(Buffer.from(invite), Buffer.from(String(settings.invite_token)));
      if (settings.is_private && !hasInvite) {
        const password = String(payload && payload.password || '');
        if (!password || !(await bcrypt.compare(password, settings.password_hash || ''))) {
          joiningRoom = false; socket.emit('room:password-required', { room: requestedRoom, error: password ? 'Senha incorreta.' : 'Esta sala é privada. Digite a senha ou use o convite.' }); return;
        }
      }
      if (!rooms[requestedRoom] && Object.keys(rooms).length >= MAX_ROOMS) {
        joiningRoom = false; socket.emit('room:join-error', 'O servidor está cheio no momento. Tente novamente mais tarde.'); return;
      }
      const r = room(requestedRoom);
      r.ownerUserId = String(settings.owner_id);
      r.maxMembers = settings.max_members;
      r.isPrivate = settings.is_private;
      const isOwner = String(socket.user.id) === r.ownerUserId;
      // Reserva uma vaga para o dono enquanto ele estiver ausente, para que
      // convidados não impeçam o retorno do proprietário da sala.
      if (!canJoinRoom(r.members, r.ownerUserId, socket.user.id, settings.max_members)) { joiningRoom = false; socket.emit('room:join-error', `Esta sala atingiu o limite de ${settings.max_members} participantes.`); return; }
      roomId = requestedRoom;
      name = socket.user.display_name;
      r.members.set(socket.id, { name, userId: String(socket.user.id), isOwner });
      r.users = r.members.size;

      // O dono tem prioridade absoluta ao entrar. Na ausência dele,
      // mantém-se o líder atual; se não houver, o primeiro convidado assume.
      socket.join(roomId);
      r.leaderId = electLeader(r.members, r.ownerUserId, r.leaderId);
      const active = await io.in(roomId).fetchSockets();
      active.forEach(client => {
        const member = r.members.get(client.id);
        client.emit('role', roleFor(client.id, member, r.leaderId));
      });
      historyId = null;
      pool.query('INSERT INTO watch_history(user_id, room_code) VALUES($1,$2) RETURNING id', [socket.user.id, roomId])
        .then(result => { historyId = result.rows[0].id; })
        .catch(err => console.error('Falha ao salvar histórico:', err));
      socket.emit('state', publicRoomState(r));
      socket.emit('room:details', { code: roomId, isPrivate: r.isPrivate, maxMembers: r.maxMembers, isOwner: String(socket.user.id) === r.ownerUserId });
      io.to(roomId).emit('system', `${name} entrou na sala`);
      publishPresence(roomId);
    } catch (err) { joiningRoom = false; console.error('Falha ao entrar na sala:', err); socket.emit('system', 'Não foi possível entrar na sala.'); }
  });

  socket.on('room:kick', async targetSocketId => {
    if (!roomId || !rooms[roomId] || String(socket.user.id) !== rooms[roomId].ownerUserId || !allowSocketEvent(socket, 'room:kick', 10, 10000)) return;
    if (typeof targetSocketId !== 'string' || targetSocketId === socket.id) return;
    const target = await io.in(targetSocketId).fetchSockets();
    const client = target.find(s => s.rooms.has(roomId));
    if (!client) return;
    client.emit('system', 'Você foi removido da sala pelo dono.');
    client.emit('room:kicked');
    const r = rooms[roomId];
    r.members.delete(targetSocketId); r.typing.delete(targetSocketId);
    client.disconnect(true);
    publishPresence(roomId); publishTyping(roomId);
  });

  socket.on('action', payload => {
    if (!roomId || !allowSocketEvent(socket, 'action', 15, 5000)) return;
    if (!payload || typeof payload !== 'object') return;
    const { type, time, videoId } = payload;
    const r = rooms[roomId];
    if (!r) return;

    if (type === 'load') {
      // A autorização é validada no servidor, não apenas na interface.
      if (socket.id !== r.leaderId) {
        socket.emit('system', 'Somente o líder atual da sala pode adicionar vídeos.');
        return;
      }

      if (
        typeof videoId !== 'string' ||
        !/^(yt:[\w-]{11}|url:https?:\/\/\S{1,2000})$/.test(videoId)
      ) {
        socket.emit('system', 'Link de vídeo inválido.');
        return;
      }

      Object.assign(r, { videoId, playing: false, time: 0 });
    } else if (type === 'play' || type === 'pause' || type === 'seek') {
      // Somente o líder atual controla a reprodução. A validação no servidor
      // impede que convidados contornem a interface e emitam eventos manualmente.
      if (socket.id !== r.leaderId) {
        socket.emit('system', 'Somente o líder atual da sala pode controlar o vídeo.');
        return;
      }
      if (!Number.isFinite(time) || time < 0) return;
      if (type === 'play') Object.assign(r, { playing: true, time });
      if (type === 'pause') Object.assign(r, { playing: false, time });
      if (type === 'seek') r.time = time;
    } else {
      return;
    }

    r.updatedAt = Date.now();
    socket.to(roomId).emit('state', publicRoomState(r));

    const messages = {
      load: 'adicionou um vídeo',
      play: 'deu play',
      pause: 'pausou',
      seek: 'pulou o vídeo'
    };
    io.to(roomId).emit('system', `${name}: ${messages[type]}`);
  });

  socket.on('profile:update', async () => {
    try {
      const result = await pool.query('SELECT display_name FROM users WHERE id=$1', [socket.user.id]);
      if (!result.rows[0]) return;
      name = result.rows[0].display_name;
      if (roomId && rooms[roomId]) {
        rooms[roomId].members.set(socket.id, { name, userId: String(socket.user.id), isOwner: String(socket.user.id) === rooms[roomId].ownerUserId });
        publishPresence(roomId);
      }
    } catch (err) { console.error('Falha ao atualizar nome da sessão:', err); }
  });

  socket.on('typing', active => {
    if (!roomId || !rooms[roomId] || !allowSocketEvent(socket, 'typing', 8, 1000)) return;
    const r = rooms[roomId];
    if (active) r.typing.add(socket.id);
    else r.typing.delete(socket.id);
    publishTyping(roomId);
  });

  socket.on('chat', text => {
    if (!roomId || !rooms[roomId] || !allowSocketEvent(socket, 'chat', 5, 10000)) return;
    const message = String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 500);
    if (!message) return;

    const r = rooms[roomId];
    io.to(roomId).emit('chat', {
      name,
      text: message,
      isCreator: socket.id === r.leaderId,
      isLeader: socket.id === r.leaderId,
      time: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })
    });

    r.typing.delete(socket.id);
    publishTyping(roomId);
  });

  socket.on('disconnect', async () => {
    if (!roomId) return;
    if (historyId) pool.query('UPDATE watch_history SET left_at=NOW() WHERE id=$1', [historyId]).catch(console.error);
    const id = roomId;
    const r = rooms[id];
    if (!r) return;

    r.members.delete(socket.id);
    r.typing.delete(socket.id);
    r.users = r.members.size;

    if (r.users <= 0) {
      delete rooms[id];
      return;
    }

    if (r.leaderId === socket.id) {
      // Se o dono ainda tiver outra conexão na sala, ela recupera a liderança.
      // Caso contrário, um convidado assume temporariamente até o dono voltar.
      const remaining = await io.in(id).fetchSockets();
      if (!rooms[id]) return;
      const ownerSocket = remaining.find(participant => String(participant.user.id) === r.ownerUserId);
      r.leaderId = electLeader(r.members, r.ownerUserId);
      for (const participant of remaining) {
        participant.emit('role', roleFor(participant.id, r.members.get(participant.id), r.leaderId));
      }
      io.to(id).emit('system', ownerSocket
        ? 'O dono voltou a estar conectado e recuperou a liderança.'
        : `${r.leaderId ? (r.members.get(r.leaderId)?.name || 'Um convidado') : 'Ninguém'} assumiu a liderança temporariamente. O dono recuperará a liderança quando voltar.`);
    } else {
      io.to(id).emit('system', `${name} saiu`);
    }

    publishPresence(id);
    publishTyping(id);
  });
});

app.use((err, req, res, next) => {
  console.error('Erro inesperado na requisição:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocorreu um erro interno. Tente novamente.' });
});

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`)))
  .catch(err => { console.error('Falha ao preparar o banco de dados:', err); process.exit(1); });
