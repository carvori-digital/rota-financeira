# Sprint de experiência — revisão local

Data: 02/10/2026. Base: `a4ae04004adbc37d7e74088d293515d881efd65b`.
Alterações salvas no workspace, sem novo commit, push, deploy ou migration.

## Experiência implementada

- Home: livre no mês, três saldos, progresso, cinco ações, três vencimentos,
  quatro atalhos, resumo compacto e contas em detalhes expansíveis.
- Progresso derivado dos registros: saídas concluídas versus previstas do
  disponível; faturas e parcelas parciais não contam como concluídas. Metas,
  dívidas e reserva mostram seu progresso real, sem pontos fictícios.
- Planejar: sete seções; projeção detalhada recolhida na visão do mês; metas
  completas também nesta área. Programadas usam os fluxos existentes de
  edição e confirmação, preservando tipo e status.
- Relatórios: fluxo, categorias, evolução em escala comum, compromissos,
  projeção de quatro meses, dívidas/quitação e taxa de economia. Períodos
  sem histórico recebem estado vazio. Projeção e valores realizados vêm
  dos motores financeiros existentes.
- Extrato: busca, filtros recolhidos, ações por registro e status relevantes.
  Pendentes encaminham para Planejar, sem realização implícita ao editar.
- Navegação: seis destinos e Lucide; Novo com seis ações principais e atalhos
  secundários preservados. Pagamento permite escolher dívida ou fatura.
- Atualização por visibilidade, reconexão e a cada minuto com a tela visível;
  os filtros permanecem durante atualização. Valores e gráficos respeitam
  o modo oculto, safe area e movimento reduzido.

## Dados e produção

Nenhum schema, migration histórica ou motor financeiro foi alterado.
Os testes de banco e browser usam PGlite local; a prévia usa um adaptador
local sem cliente Supabase real, credenciais ou escritas persistentes.

A auditoria remota usa exclusivamente SELECT em transação READ ONLY, nas
14 tabelas financeiras. Comparou IDs e fingerprints de todos os campos,
exceto `updated_at`: 20 registros preexistentes intactos e 11 novos registros
encontrados durante a sprint. As três contas originais permaneceram intactas.
Nenhum dado QA foi criado no banco real. Fingerprints ficam somente em
`test-results/`, ignorado pelo Git; não contêm os valores financeiros em claro.

## Validação

- `npm test`: 68 aprovados (32 unitários, 11 de banco, 25 de interface).
- `npm run typecheck`, `npm run lint`, `npm run build`: aprovados.
- Browser financeiro: 30 verificações, zero erros e zero chamadas externas.
- Browser de experiência: 47 verificações em 375, 390 e 430 px, zero erros e
  zero chamadas externas. Inclui relatórios, sete seções de Planejar, busca,
  filtros, modais, navegação, projeção compartilhada e valores ocultos.
- Imagens revisadas em `test-results/experience/`; resultados dos dois
  browsers em seus respectivos `report.json`.
- O build mantém aviso de bundle principal acima de 500 kB, sem falha.

## Revisão visual

`npm run preview:experience` → http://127.0.0.1:5175

A prévia exibe o aviso “dados de demonstração · somente revisão visual”.
Permite navegar e abrir formulários; salvar retorna aviso e não altera dados.
Os fluxos de gravação foram validados separadamente no PostgreSQL local.

Para repetir os browsers, configurar `PLAYWRIGHT_MODULE` para o módulo
Playwright disponível no host e executar `npm run test:mobile` e
`npm run test:experience`. O segundo inicia seu próprio servidor na porta 5176.

Próxima ação: revisar visualmente a prévia local. Publicação não autorizada
nesta etapa.
