# CDI / RDB — pesquisa e contrato de cálculo

Consulta em 13/10/2026. Fontes oficiais, sem dados financeiros reais:

- [Nubank — Caixinhas](https://nubank.com.br/nu/caixinhas). O endereço `/nu/conta/caixinha-turbo` e o artigo antigo Turbo redirecionam para esta página. Liquidez imediata descrita para o produto; movimentação de R$900 por ciclo de 31 dias condiciona 115%; vencimento deve ser consultado no app. A página tem diferenças entre segmentos (Croma, NuCel, Nubank+, Ultravioleta); o contrato individual prevalece.
- [Nubank — RDB](https://blog.nubank.com.br/o-que-e-rdb/), atualizado 21/09/2026. IR regressivo 22,5% até 180 dias, 20% de 181–360, 17,5% de 361–720, 15% acima de 720; IOF sobre rendimento antes de 30 dias. Liquidez depende do emissor/produto. A regra de 31 dias para a CONTA não é transplantada à Caixinha.
- [B3 — Taxa DI](https://borainvestir.b3.com.br/glossario/taxa-di/). DI reflete empréstimos interbancários; Selic relaciona-se a títulos públicos. Taxa anual DI é base 252 dias úteis; não usar Selic como substituta de CDI.
- [B3 — metodologia de apuração](https://b3.com.br/pt_br/market-data-e-indices/indices/indices-de-segmentos-e-setoriais/di/metodologia-de-apuracao-da-taxa/).
- [B3 — cálculo acumulado](https://b3.com.br/main.jsp?lumA=1&lumII=2C9FBE63638CFE2501638D373B435E37&lumPageId=2C9FBE63638CFE2501638D3464C8577B). Resultado indexado oficial consultado; abertura integral sofreu timeout. Refere período inicial inclusivo/final exclusivo, fatores diários e truncamento intermediário a 16 casas. Não alegar equivalência exata ao motor contratual.
- [BCB — SGS 12](https://www3.bcb.gov.br/sgspub/consultarvalores/consultarValoresSeries.do?hdOidSeriesSelecionadas=12&method=consultarGraficoPorId): CDI em `% a.d.`. [API JSON](https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json).

## Motor implementado

Para cada data `d` publicada na SGS 12: `f_d = 1 + (valor_SGS12_d / 100) * (percentual_CDI_vigente_d / 100)`.
Posição capitaliza pelo produto dos fatores; 115 é multiplicador 1,15 sobre a taxa diária, não sobre o fator inteiro. SGS 12 já é diária: não aplicar raiz 252 nem tratar como anual. Movimentos são ordenados por data/ordem imutável do razão (fallback criação/id nas fixtures sem ordem), ocorrem antes do fator dessa data; intervalo `[aporte, data de posição)`. Cada aporte começa em sua própria data. Fins de semana/feriados sem observações não recebem fatores. O dia da posição é exclusivo.

Sincronizações novas guardam alvo absoluto e estabelecem nova âncora na data. Não são capital novo. Rendimento após âncora é separado de ajustes. Histórico importado é posição sem débito bancário; aportes reais seguem RPC com transação de conta.

Precisão: IEEE-754, taxa no grau de precisão devolvido pela SGS 12, sem arredondamento monetário por dia; arredondamento em centavos no resultado. Não reproduz truncamentos internos do contrato B3/Nubank. Diferenças são esperadas; conferir com saldo oficial. Unidade e datas são validadas; dados inválidos/duplicados/vazios são rejeitados.

## Fonte, cache e limitações

Atualização explícita no navegador por janelas anuais da API BCB, sem chaves, cookies ou envio de valores/identificadores financeiros. Cache local apenas de índice público, com fonte, intervalo solicitado e hora da consulta; substituição atômica após sucesso de todas as janelas. Sem histórico com cobertura da âncora até a data: retorna posição registrada, rendimento indisponível e aviso. Não há taxa fixa/fictícia de fallback.

A resposta completa da API é a evidência de calendário; não possuímos calendário B3 independente para detectar omissão interna da fonte. Cache pode ficar desatualizado: data de coleta fica visível. CORS/conectividade e dados SGS devem ser validados no navegador local. CDI não atualiza automaticamente patrimônios futuros. Valores são estimativas, não saldos garantidos.

Percentuais novos só vigem hoje ou no futuro e não podem sobrescrever taxas já registradas. Na reconstrução o usuário escolhe percentual inicial; se houve regimes históricos distintos antes da âncora, não declarar rendimento anterior preciso. Não inferir elegibilidade Nubank nem troca automática para 100%. Se o banco resgatar/reaplicar ao mudar regras, confirmar extrato, datas e tributos; uma simples alteração de percentual não simula esse evento.

Não exibimos líquido preciso: não há lotes fiscais, ordem contratual dos resgates, IR/IOF retidos ou identificação do saldo informado como bruto/líquido. Histórico e sincronizações agregadas são insuficientes para tributação segura. A interface informa esse limite. O saldo do banco prevalece.

Backend CDI usa posição REGISTRADA (última sincronização mais fluxos posteriores) para limites de resgate; não credita rendimento estimado em conta. Para resgatar acima desse limite, sincronizar antes com o valor efetivo. Cálculos fixos existentes permanecem independentes.
