# Implementação — Central completa de Relatórios

## Objetivo
Transformar a aba **Relatórios** em uma central única de acompanhamento e planejamento financeiro mensal. A pessoa deve conseguir entender o mês selecionado, identificar exatamente o que compõe cada total e administrar previsões futuras sem precisar encontrar uma área de Planejamento escondida na Home.

## Branch e limites obrigatórios
- Trabalhar exclusivamente na branch `feat/reports-central`.
- A branch foi criada a partir de `main` (commit-base: `6491740704d9a0b2f8688e40b33e0ce517c9f0b8`).
- Não fazer merge, não publicar, não acionar deploy e não alterar `main`.
- **Não tocar no Supabase, banco real, migrations, SQL, políticas RLS, variáveis de ambiente, autenticação ou estrutura de dados remota.**
- Não inserir, editar, excluir, corrigir ou migrar lançamentos financeiros reais.
- Não alterar regras de assinaturas, cartões, investimentos, reservas, dívidas ou patrimônio, salvo leitura necessária para exibir dados já existentes.
- Não fazer refatoração ampla fora do escopo. Preservar o comportamento existente que não estiver diretamente relacionado.
- Antes de qualquer comando, conferir a branch atual. Se não estiver em `feat/reports-central`, parar e corrigir a branch antes de editar.
- Não inventar campos, fontes de dados, categorias ou valores. Reutilizar as funções e estruturas existentes.

## Escopo funcional

### 1. Relatórios vira a central
- Usar a aba Relatórios já existente na navegação principal como entrada da central.
- Incorporar nela as áreas de Planejamento atualmente separadas: visão do mês, programadas, recorrentes e metas.
- Evitar duas áreas concorrentes ou cópias da mesma funcionalidade.
- Atualizar os atalhos da Home que hoje levam a Planejamento para abrir a área correspondente dentro de Relatórios.
- Preservar a navegação principal e os fluxos de criação/edição existentes.

### 2. Seletor de mês
- Permitir selecionar meses passados, atual e futuros.
- Hoje há uma limitação no seletor de Reports que impede meses futuros; removê-la sem confundir o mês visualizado com a data real atual.
- Manter separados: (a) data atual de referência para distinguir realizado de previsto; (b) mês escolhido pelo usuário para visualização.
- Ao abrir um mês futuro, apresentar valores como previstos/pendentes, nunca como realizados.
- Alterar o mês deve atualizar todas as seções da central de forma coerente.

### 3. Panorama do mês
Apresentar com hierarquia visual clara:
- saldo de abertura;
- receitas realizadas;
- receitas pendentes/programadas;
- despesas realizadas;
- despesas pendentes/compromissos;
- saldo final realizado, quando aplicável;
- saldo projetado ao fim do mês.

Cada total deve permitir entender quais lançamentos o compõem. Diferenciar visualmente realizado, pendente e previsão. Não somar o mesmo lançamento duas vezes quando ele também vier de recorrência/projeção.

### 4. Detalhamento de entradas e saídas
- Exibir listas identificáveis de receitas e despesas que compõem os totais do mês selecionado.
- Mostrar descrição, valor, data e situação; categoria quando existir.
- Separar realizado, pendente/programado e recorrência projetada.
- Permitir abrir/editar lançamentos pendentes pelos fluxos já existentes, inclusive receitas futuras com valor ou data alterados.
- Não permitir que uma projeção agregada pareça ser um lançamento real editável.
- Mostrar estados vazios úteis, sem esconder dados apenas porque já foram concluídos.

### 5. Projeção dos próximos meses
- Reaproveitar a projeção atual e seu horizonte existente, sem criar uma segunda fórmula financeira paralela.
- Tornar cada mês expansível e mostrar os lançamentos que formam abertura, entradas, saídas e saldo projetado.
- Identificar cada item com descrição, valor, data e origem/situação quando disponíveis.
- Distinguir lançamento confirmado/pendente de previsão recorrente.
- Permitir navegar para um mês futuro e administrar seus itens quando houver lançamento editável.

### 6. Programadas, recorrentes e metas
- Trazer para dentro de Relatórios os recursos de Planejamento já existentes.
- Em Programadas, mostrar entradas e saídas futuras pendentes, editáveis pelos fluxos existentes.
- Garantir que receitas programadas também apareçam (não apenas despesas).
- Em Recorrentes, manter o gerenciamento existente e deixar evidente quais previsões entram em cada mês.
- Em Metas, preservar a funcionalidade já existente.
- Evitar alterar a regra de recorrência ou criar lançamentos duplicados.

## Regras financeiras críticas para validar
- Um lançamento realizado não pode continuar sendo contado como pendente.
- Uma parcela já paga não pode aparecer novamente na projeção. Caso de referência: parcela 10/11 já paga em novembro; somente a 11/11 deve permanecer em dezembro.
- A conta Cemig pendente de novembro não deve ser automaticamente tratada como o valor da conta de dezembro. Dezembro terá uma conta de valor próprio; não alterar a regra geral de recorrência com base nesse caso isolado.
- Reserva e investimentos não entram no saldo disponível ou na projeção de caixa como se fossem dinheiro livre, respeitando as regras atuais do app.
- Não fazer ajustes nos dados do usuário para fazer os testes passarem.

## Fora do escopo desta entrega
- Arquivar/excluir dívidas quitadas.
- Redesenhar a tela de cartões/faturas.
- Mudanças em assinaturas, investimentos, reservas, patrimônio e regras de recorrência.
- Qualquer mudança no backend, banco, migrations, autenticação ou publicação.

## UX e qualidade
- Prioridade absoluta para celular: hierarquia clara, textos legíveis, alvos de toque adequados e pouca rolagem desnecessária.
- Evitar cartões repetitivos e números sem explicação.
- Reaproveitar componentes visuais e padrões atuais do projeto.
- Não deixar informação essencial escondida em accordions sem indicação clara.
- Manter acessibilidade básica, estados de carregamento, vazio e erro.

## Plano de execução obrigatório
1. Inspecionar o estado da branch e os arquivos atuais; ler `Reports.tsx`, `PlanningWorkspace.tsx`, `BottomNavigation.tsx`, cálculos/projeções e testes relacionados. Não confiar em descrições antigas se o código atual divergir.
2. Descrever rapidamente a arquitetura encontrada e o plano de arquivos a alterar.
3. Implementar o escopo em etapas pequenas, com componentes e cálculos reutilizados sempre que possível.
4. Adicionar/ajustar testes para seleção de meses futuros, detalhamento de entradas e saídas, estados realizado/pendente/previsto, ausência de duplicidade, projeção por mês e regras críticas acima.
5. Executar os testes existentes relevantes, a suíte completa disponível e o build. Corrigir falhas introduzidas pela mudança.
6. Revisar o diff para confirmar que não houve alterações fora do escopo, nem arquivos de banco/migrations/configuração remota.
7. Fazer commit(s) na branch `feat/reports-central`, com mensagens claras, somente depois de testes passarem.

## Entrega esperada
Ao terminar, informar:
- o que foi implementado;
- arquivos alterados;
- testes executados e resultados reais;
- limitações ou pendências encontradas;
- hash do commit;
- confirmação explícita de que não houve alteração no Supabase/banco real, migrations, `main` ou produção.

**Não fazer merge nem deploy.** Se surgir necessidade de tocar em banco, regra financeira fora do escopo ou dado real, parar e explicar o bloqueio em vez de improvisar.
