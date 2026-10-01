# Rota Financeira · V0.1

React + TypeScript + Vite, Supabase Auth/Postgres e PWA mobile. Sem dados fictícios nem armazenamento local de dados financeiros. A sessão de autenticação é persistida pelo Supabase.

## Executar

Node 22.18+ (ou Node 24+) e npm. Execute `npm ci`, copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` com a URL e a chave **publishable** do projeto Supabase já criado. A chave anon legada também é aceita; service_role/secret são recusadas. Nunca use chaves administrativas no frontend. Reinicie o Vite após mudar o ambiente.

Execute `npm run dev`. Sem configuração válida, a aplicação mostra instruções e não grava dados.

## Banco e autenticação

Use o projeto Supabase existente. Não é necessário criar outro: em novos ambientes, o projeto seria criado pelo painel Supabase e configurado pelos mesmos passos abaixo.

No SQL Editor do projeto correto, execute integralmente **`supabase/migrations/202610010001_initial.sql`**, uma única vez. A migration é transacional e cria schema, constraints, RLS, índices e categorias padrão. Para ambientes gerenciados pela CLI, use migrations versionadas com `supabase db push` somente após conferir o projeto vinculado.

Em Authentication → URL Configuration, configure Site URL e Redirect URLs para `http://127.0.0.1:5173` e depois a URL HTTPS publicada. Habilite o provedor Email. A aplicação suporta confirmação de e-mail: se habilitada, o usuário confirma antes de entrar. Para uso privado imediato, pode desabilitar Confirm email no painel; isso é uma escolha do proprietário. Para recuperação de senha em produção, configure o envio de e-mails/SMTP e confira o redirect.

## Validação

`npm run lint`, `npm test`, `npm run typecheck`, `npm run build`. `npm test` inclui as suítes financeira, banco e interface. Os testes de interface usam um Supabase simulado exclusivamente em teste para validar gravações, falhas, transferências, aportes e logout.

`npm run test:db` executa a migration em PostgreSQL embarcado de teste e valida RLS, constraints, seed e transferência. Isso não substitui o teste no Supabase real.

Para comprovar isolamento no projeto real, crie **dois usuários exclusivos de teste**, confirmados. Defina no terminal as variáveis da `.env.example` e `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD` sem salvar senhas no projeto. Execute `npm run test:isolation`. O teste verifica listar/ler/editar/excluir/inserir em nome do outro nas cinco tabelas, em ambas as direções, e relações cruzadas. Cria apenas fixtures identificadas e as remove ao terminar. Não use contas com dados reais.

Validação manual: cadastrar/entrar, criar duas contas, receita/despesa, transferir, editar/excluir, arquivar/reativar, criar objetivo/aporte e excluir aporte; conferir dashboard, filtros e reabertura com sessão. Recuperar senha pelo e-mail. Repetir no Safari iPhone e adicionar à tela inicial.

## Regras financeiras

- Valores são inteiros em centavos no frontend e bigint no Postgres, limitados a R$ 10 bilhões por registro. Digite `1250,50`, sem separador de milhar.
- Transferência é **uma linha** com origem e destino: a gravação/edição/exclusão é atômica. O cálculo debita a origem, credita o destino e exclui transferências de receitas/despesas. FKs compostas asseguram mesmo proprietário e categoria compatível.
- Saldo total inclui contas arquivadas e considera lançamentos até hoje. Resumo mensal inclui todos os lançamentos do mês selecionado, inclusive datas futuras, caso cadastradas.
- Saldo inicial é a posição anterior aos lançamentos cadastrados; não cadastre o mesmo saldo como receita. Mudá-lo recalcula o saldo.
- Aportes de objetivos registram progresso, não despesas nem transferências. Não somar objetivos ao patrimônio: isso duplicaria dinheiro. Recorrências são marcações, sem agendador.
- Desativar contas/objetivos preserva histórico. Alterar o tipo de categoria já usada é impedido pelo banco. RLS valida `auth.uid()` e FKs validam relações; `user_id` é preenchido pelo banco. Identidades dos registros são imutáveis.
- PWA sem cache de respostas ou modo financeiro offline. Dados vivem na memória da tela e no Supabase; apenas a sessão é persistida. Não use em dispositivo compartilhado sem sair da conta.

## GitHub e Vercel

O repositório local não tinha remoto. Antes de conectar, confira `gh auth status` e `git remote -v`. Crie/escolha o repositório na conta correta e adicione `git remote add origin <URL-confirmada>`; só depois faça push da branch local. `.env.local` é ignorado.

Na conta Vercel correta, importe esse repositório em **um novo projeto ou destino explicitamente confirmado**. Framework: Vite; build: `npm run build`; output: `dist`. Cadastre somente as duas variáveis públicas VITE do projeto correto. Faça deploy, configure a URL HTTPS no Supabase e execute o teste de isolamento e o roteiro manual. `vercel.json` prepara SPA, headers de segurança e no-store. Para domínio Supabase customizado, ajuste `connect-src` na CSP para o domínio exato.

No iPhone: Safari → Compartilhar → Adicionar à Tela de Início. Ícones temporários incluídos. Termos e privacidade precisam ser concluídos antes de distribuição pública ampla. Sem publicação ou teste real de banco, a prontidão de produção permanece não verificada.
