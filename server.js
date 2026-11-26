const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// Estado de cada sala: vídeo, tocando ou não, posição e quando foi atualizado
const rooms = {};
const room = id => (rooms[id] ??= { videoId: null, playing: false, time: 0, updatedAt: Date.now(), users: 0 });

io.on('connection', socket => {
  let roomId = null, name = 'Anônimo';

  socket.on('join', ({ room: id, name: n }) => {
    roomId = String(id).toUpperCase().slice(0, 8);
    name = String(n || 'Anônimo').slice(0, 20);
    socket.join(roomId);
    const r = room(roomId);
    r.users++;
    socket.emit('state', r);
    io.to(roomId).emit('system', `${name} entrou (${r.users} na sala)`);
  });

  // load / play / pause / seek: atualiza o estado e repassa para os outros
  socket.on('action', ({ type, time, videoId }) => {
    if (!roomId) return;
    const r = room(roomId);
    if (type === 'load') Object.assign(r, { videoId, playing: false, time: 0 });
    if (type === 'play') Object.assign(r, { playing: true, time });
    if (type === 'pause') Object.assign(r, { playing: false, time });
    if (type === 'seek') r.time = time;
    r.updatedAt = Date.now();
    socket.to(roomId).emit('state', r);
    io.to(roomId).emit('system', `${name}: ${({ load: 'trocou o vídeo', play: 'deu play', pause: 'pausou', seek: 'pulou o vídeo' })[type]}`);
  });

  socket.on('chat', text => {
    if (roomId && text) io.to(roomId).emit('chat', { name, text: String(text).slice(0, 500) });
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const r = room(roomId);
    r.users--;
    if (r.users <= 0) delete rooms[roomId];
    else io.to(roomId).emit('system', `${name} saiu`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
