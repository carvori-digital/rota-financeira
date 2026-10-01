# Rota Financeira · V0.1

React + TypeScript + Vite, Supabase Auth/Postgres e PWA mobile. Sem dados fictícios nem armazenamento local de dados financeiros. A sessão de autenticação é persistida pelo Supabase.

## Executar

Node 22.18+ (ou Node 24+) e npm. Execute `npm ci`, copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` com a URL e a chave **publishable** do projeto Supabase já criado. A chave anon legada também é aceita; service_role/secret são recusadas. Nunca use chaves administrativas no frontend. Reinicie o Vite após mudar o ambiente.

Execute `npm run dev` e abra `http://127.0.0.1:5173`. Para testar o build e a PWA, execute `npm run build` e `npm run preview`, e abra `http://127.0.0.1:42817`. As portas são fixas para corresponder aos retornos de Auth; se estiverem ocupadas, o comando avisa em vez de trocar silenciosamente de porta. Sem configuração válida, a aplicação mostra instruções e não grava dados.

## Banco e autenticação

Use o projeto Supabase existente. Não é necessário criar outro: em novos ambientes, o projeto seria criado pelo painel Supabase e configurado pelos mesmos passos abaixo.

A migration **`supabase/migrations/202610010001_initial.sql`** é transacional e cria schema, constraints, RLS, índices e categorias padrão. Foi aplicada via CLI ao projeto **Rota Financeira**, ref `lgcozsoenycvifiygdsj`, após confirmar o nome remoto e executar dry-run. Não precisa executá-la novamente no SQL Editor.

Para migrations futuras, use a CLI oficial (`npx --yes supabase`; versão validada: 2.119.0). Autentique com `npx --yes supabase login --no-browser --agent no --output-format text` no navegador/perfil correto. Confira `npx --yes supabase whoami` e `npx --yes supabase projects list`, depois vincule com `npx --yes supabase link --project-ref lgcozsoenycvifiygdsj`. Execute primeiro `npx --yes supabase db push --linked --dry-run --skip-vault`; confira a lista antes de aplicar `npx --yes supabase db push --linked --skip-vault`. Nesta execução, a sessão autenticada permitiu usar uma role temporária de banco sem solicitar a senha do banco. Nunca use `db reset` no projeto remoto. A sessão da CLI e o vínculo em `supabase/.temp` não vão para o Git.

Os retornos `http://127.0.0.1:5173` e `http://127.0.0.1:42817` já estão autorizados no Supabase. O provedor Email e a confirmação de e-mail estão habilitados: após cadastrar, confirme pelo link recebido antes de entrar. O frontend envia sua URL atual como retorno de cadastro/recuperação. As demais configurações foram preservadas. Após publicação, adicione a URL HTTPS de produção aos retornos e configure Site URL; valide confirmação e recuperação com uma caixa de e-mail real e configure SMTP para distribuição pública.

## Validação

`npm run lint`, `npm test`, `npm run typecheck`, `npm run build`. `npm test` inclui as suítes financeira, banco e interface. Os testes de interface usam um Supabase simulado exclusivamente em teste para validar gravações, falhas, transferências, aportes e logout.

`npm run test:db` executa a migration em PostgreSQL embarcado de teste e valida RLS, constraints, seed e transferência. Isso não substitui o teste no Supabase real.

O isolamento também foi validado no PostgreSQL remoto com `npx --yes supabase db query --linked --file scripts/test-isolation.sql`. O script cria fixtures e usuários temporários, simula os JWTs com a role `authenticated`, testa ambas as direções nas cinco tabelas e as relações entre entidades, e reverte toda a transação. Não mantém usuários nem dados de teste. Esse teste comprova as regras do banco; o roteiro por API abaixo também verifica o acesso com sessões reais de Auth.

Para comprovar isolamento no projeto real, crie **dois usuários exclusivos de teste**, confirmados. Defina no terminal as variáveis da `.env.example` e `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD` sem salvar senhas no projeto. Execute `npm run test:isolation`. O teste verifica listar/ler/editar/excluir/inserir em nome do outro nas cinco tabelas, em ambas as direções, e relações cruzadas. Cria apenas fixtures identificadas e as remove ao terminar. Não use contas com dados reais.

`npm run test:live` automatiza os fluxos reais de Auth e dados usando o projeto confirmado, a chave pública de `.env.local` e a sessão da CLI. Cria somente dois usuários descartáveis por SQL, sem enviar e-mail ou mudar a confirmação global, e os remove junto com seus registros ao final. Testa login, restauração de sessão, logout, categorias padrão, contas, receitas/despesas, transferência, objetivos/aportes, histórico preservado e isolamento via API. Credenciais temporárias não são exibidas nem versionadas. SQL temporário fica em `test-results/`, ignorado, e é removido. Esse teste depende da estrutura atual de Auth e não é um método de cadastro da aplicação.

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

O destino GitHub indicado pelo proprietário é **carvori-digital**. O CLI aponta para essa conta, mas sua credencial precisa ser renovada. O repositório local ainda não tem remoto; a URL do repositório e a conta/projeto Vercel precisam ser confirmados antes de push/deploy. Confira `gh auth status` e `git remote -v`, autentique na conta correta e adicione `git remote add origin <URL-confirmada>`; só depois faça push da branch local. `.env.local` é ignorado.

Na conta Vercel correta, importe esse repositório em **um novo projeto ou destino explicitamente confirmado**. Framework: Vite; build: `npm run build`; output: `dist`. Cadastre somente as duas variáveis públicas VITE do projeto correto. Faça deploy, configure a URL HTTPS no Supabase e execute o teste de isolamento e o roteiro manual. `vercel.json` prepara SPA, headers de segurança e no-store. Para domínio Supabase customizado, ajuste `connect-src` na CSP para o domínio exato.

No iPhone: Safari → Compartilhar → Adicionar à Tela de Início. Ícones temporários incluídos. Termos e privacidade precisam ser concluídos antes de distribuição pública ampla. Sem publicação ou teste real de banco, a prontidão de produção permanece não verificada.
