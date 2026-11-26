# Sessão — assistir junto

## Estrutura
- `server.js`: servidor Socket.IO, salas, permissões, presença e digitação.
- `public/index.html`: interface do site.
- `package.json`: dependências e comando de inicialização.

## Instalação
1. Coloque `server.js` e `package.json` na raiz do projeto.
2. Coloque `index.html` dentro da pasta `public`.
3. Execute `npm install`.
4. Execute `npm start`.

O primeiro participante a entrar em uma sala é o criador. Somente ele pode adicionar ou trocar o vídeo. Se ele sair, um participante restante assume a administração.

Observação: as salas são mantidas em memória. Reiniciar o servidor apaga as salas ativas.
