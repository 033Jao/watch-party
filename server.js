const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const rooms = {};
const room = id => (rooms[id] ??= {
  videoId: null,
  playing: false,
  time: 0,
  updatedAt: Date.now(),
  users: 0,
  creatorId: null,
  members: new Map(),
  typing: new Set()
});

function publishPresence(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  const people = [...r.members.entries()].map(([id, name]) => ({
    id,
    name,
    isCreator: id === r.creatorId
  }));
  io.to(roomId).emit('presence', people);
}

function publishTyping(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  const names = [...r.typing].map(id => r.members.get(id)).filter(Boolean);
  io.to(roomId).emit('typing', names);
}

io.on('connection', socket => {
  let roomId = null;
  let name = 'Anônimo';

  socket.on('join', ({ room: id, name: n } = {}) => {
    if (roomId) return;

    roomId = String(id || '').toUpperCase().slice(0, 8);
    if (!roomId) {
      roomId = null;
      return;
    }

    name = String(n || 'Anônimo').trim().slice(0, 20) || 'Anônimo';
    const r = room(roomId);

    socket.join(roomId);
    r.users++;
    r.members.set(socket.id, name);

    // O primeiro participante da sala é o criador.
    if (!r.creatorId) r.creatorId = socket.id;

    socket.emit('state', r);
    socket.emit('role', { isCreator: socket.id === r.creatorId });
    io.to(roomId).emit('system', `${name} entrou na sala`);
    publishPresence(roomId);
  });

  socket.on('action', ({ type, time, videoId } = {}) => {
    if (!roomId) return;
    const r = rooms[roomId];
    if (!r) return;

    if (type === 'load') {
      // A autorização é validada no servidor, não apenas na interface.
      if (socket.id !== r.creatorId) {
        socket.emit('system', 'Somente o criador da sala pode adicionar vídeos.');
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
      if (!Number.isFinite(time) || time < 0) return;
      if (type === 'play') Object.assign(r, { playing: true, time });
      if (type === 'pause') Object.assign(r, { playing: false, time });
      if (type === 'seek') r.time = time;
    } else {
      return;
    }

    r.updatedAt = Date.now();
    socket.to(roomId).emit('state', r);

    const messages = {
      load: 'adicionou um vídeo',
      play: 'deu play',
      pause: 'pausou',
      seek: 'pulou o vídeo'
    };
    io.to(roomId).emit('system', `${name}: ${messages[type]}`);
  });

  socket.on('typing', active => {
    if (!roomId || !rooms[roomId]) return;
    const r = rooms[roomId];
    if (active) r.typing.add(socket.id);
    else r.typing.delete(socket.id);
    publishTyping(roomId);
  });

  socket.on('chat', text => {
    if (!roomId || !rooms[roomId]) return;
    const message = String(text || '').trim().slice(0, 500);
    if (!message) return;

    const r = rooms[roomId];
    io.to(roomId).emit('chat', {
      name,
      text: message,
      isCreator: socket.id === r.creatorId,
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

    if (r.creatorId === socket.id) {
      const remaining = await io.in(id).fetchSockets();
      if (!rooms[id]) return;

      if (!remaining.length) {
        delete rooms[id];
        return;
      }

      r.creatorId = remaining[0].id;
      for (const participant of remaining) {
        participant.emit('role', {
          isCreator: participant.id === r.creatorId
        });
      }

      io.to(id).emit('system', 'O criador saiu. Um novo administrador foi escolhido.');
    } else {
      io.to(id).emit('system', `${name} saiu`);
    }

    publishPresence(id);
    publishTyping(id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
