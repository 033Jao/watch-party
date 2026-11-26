# Watch party (protótipo estilo Rave)

Salas por código, vídeo do YouTube sincronizado (play, pausa, pulos) e chat.

## Rodar no computador
1. Instale o Node.js 18 ou mais novo.
2. Nesta pasta: `npm install` e depois `npm start`.
3. Abra http://localhost:3000. Para testar, abra duas abas na mesma sala.

## Usar com amigos de verdade
Publique a pasta num serviço gratuito que rode Node (Render, Railway ou Glitch):
envie os arquivos, comando de início `npm start`. Depois é só mandar o link e o código da sala.

## Como funciona
- `server.js` guarda o estado de cada sala (vídeo, tocando, posição) e repassa eventos por WebSocket.
- Cada navegador toca o vídeo direto do YouTube; o servidor só sincroniza.
- Se alguém ficar mais de 1 s atrasado, o player é ajustado automaticamente.
