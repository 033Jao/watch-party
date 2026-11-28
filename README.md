# Watch Party

Plataforma para assistir vídeos juntos por link, com reprodução sincronizada, salas públicas/privadas e chat em tempo real.

## Recursos
- Cadastro e login por e-mail e senha.
- Senhas protegidas com hash bcrypt.
- Perfil com nome e foto por URL HTTPS.
- Histórico das últimas 30 salas visitadas.
- Sessões persistentes no PostgreSQL.
- Salas públicas e privadas, com senha ou link de convite.
- Limite configurável de participantes por sala (2 a 30).
- Sistema de amizade: busca, solicitação, aceitar, recusar, remover e bloquear.
- Convites diretos para amigos dentro de uma sala.
- Notificações de solicitações, amizades aceitas e convites para salas.
- O dono da sala tem prioridade de liderança. Se ele sair, um participante conectado assume temporariamente; quando o dono voltar, recupera automaticamente a liderança. Apenas o líder atual pode adicionar links e controlar a reprodução; expulsar participantes continua exclusivo do dono.
- O cliente tenta entrar novamente na sala após uma reconexão de rede, mantendo as credenciais da sala apenas na memória da página.
- Chat em tempo real e comentários flutuantes sobre o vídeo.

Os vídeos são adicionados diretamente por link. Não existe biblioteca de vídeos salvos.

## Arquivos
- `server.js`: servidor, autenticação, sessões, banco de dados, amizades, notificações e salas.
- `room-leadership.js`: eleição determinística do líder e cálculo de permissões.
- `public/index.html`: interface do site.
- `package.json`: dependências e inicialização.

## Configuração local
1. Instale Node.js 18 ou superior e PostgreSQL.
2. Crie um banco PostgreSQL para o projeto.
3. Configure `DATABASE_URL` e `SESSION_SECRET` usando `.env.example` como referência.
4. Defina `NODE_ENV=production` em produção.
5. Execute `npm install`, depois `npm test` para os testes unitários e `npm start` para iniciar o servidor.

As tabelas `users`, `watch_history`, `rooms`, `friend_requests`, `user_blocks` e `notifications` são criadas automaticamente. A tabela de sessões também é criada automaticamente.

## Publicação no Render
1. Configure `DATABASE_URL` com a Internal Database URL do PostgreSQL.
2. Configure `SESSION_SECRET` com uma chave aleatória longa.
3. Defina `NODE_ENV=production`.
4. Configure `PGSSL=true` somente se seu provedor PostgreSQL exigir TLS externo com certificado validado.

Não publique `.env`, `DATABASE_URL` ou `SESSION_SECRET`.

## Segurança e desempenho
- Helmet para cabeçalhos HTTP de segurança.
- Cookies de sessão `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Regeneração da sessão ao autenticar.
- Limites de tentativas de login/cadastro, alterações de perfil, criação de salas, amizades e ações Socket.IO.
- Verificação obrigatória do cabeçalho Origin nas requisições de alteração da API.
- Política CSP limitada aos serviços externos usados pelo player e pelo HLS.js.
- PUBLIC_URL obrigatório em produção para evitar envenenamento de links por cabeçalho Host.
- Consultas SQL parametrizadas e verificação de permissões no servidor.
- Somente amigos aceitos podem receber convites diretos.
- Somente membros conectados ou o dono da sala podem enviar convites.
- Tamanho máximo de JSON e de pacotes Socket.IO.
- Índices para histórico, salas, amizades e notificações.
- Pool PostgreSQL limitado para evitar excesso de conexões.

Os limitadores de frequência ficam em memória por processo. Se o serviço for escalado para várias instâncias, use armazenamento compartilhado (como Redis) para limites globais.

## Limitações conhecidas
- Salas ativas e estado de reprodução ficam em memória e são encerrados quando o servidor reinicia.
- O sistema de presença e os limites por processo precisam de armazenamento compartilhado se houver múltiplas instâncias.
- Os testes unitários cobrem a eleição de liderança. A integração com PostgreSQL real, login por navegador e testes simultâneos com várias contas ainda precisam ser executados no ambiente de hospedagem antes da publicação.
