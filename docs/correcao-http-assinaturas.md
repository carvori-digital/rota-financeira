# Correção da tela branca em HTTP — 23/10/2026

Branch: `codex/cheque-especial-consolidado`. Base confirmada: `ec6109c`.

## Causa confirmada no Cloud

Na base, abrir **Carteira → Assinaturas → Adicionar assinatura** em uma origem
HTTP insegura reproduziu `TypeError: crypto.randomUUID is not a function` durante
a montagem de `SubscriptionEditor`. Sem um Error Boundary, o React desmontava a
aplicação: `#root.innerText` ficava vazio.

Reprodução com Chromium/Playwright em `http://rota-insecure.test:5177`:

```json
{
  "isSecureContext": false,
  "randomUUID": "undefined",
  "getRandomValues": "function"
}
```

O Playwright encaminha somente o transporte dessa origem para o Vite local;
a origem do documento continua insegura. Não há simulação/remoção manual de
`randomUUID` nos testes de navegador. A prévia usa dados sintéticos e bloqueia
todo tráfego externo. O IP do notebook não foi acessado.

## Correção

- `src/lib/uuid.ts` centraliza UUID v4: usa o método nativo quando disponível e,
  caso contrário, 16 bytes de `crypto.getRandomValues`, com bits de versão e
  variante corretos. Não usa `Math.random`; sem fonte segura, falha explicitamente.
- Todas as chamadas diretas no cliente foram substituídas: assinaturas,
  lançamentos, planejamento, investimentos, reconstrução, cheque especial e
  conferência bancária. IDs são inicializados por estado lazy e preservados
  durante re-renderizações, etapas de revisão e tentativas de salvamento.
  Uma nova abertura cria novos IDs; o retorno explícito à conferência bancária
  continua iniciando um novo pedido, como antes.
- Error Boundary local preserva o painel de assinaturas quando o editor falha,
  com feedback, nova tentativa e fechamento. Um Error Boundary na raiz oferece
  feedback e nova tentativa para falhas de renderização no restante da aplicação.
  Os tratamentos existentes de erros de salvamento continuam ativos.

## Validação

| Verificação                                                                     | Resultado                 |
| ------------------------------------------------------------------------------- | ------------------------- |
| Unitários, incluindo UUID nativo, fallback, bits, unicidade e falta de entropia | 82 aprovados              |
| Integração/regressões de banco, somente PGlite local                            | 90 aprovados              |
| Interface, com `randomUUID` indisponível em toda a suíte                        | 59 aprovados              |
| Navegação/layout em HTTP inseguro, 320/375/390/430 px                           | 45 verificações aprovadas |
| Navegação/layout em localhost, com UUID nativo disponível                       | 45 verificações aprovadas |
| Navegador com RPCs reais no PGlite e HTTP inseguro                              | 77 verificações aprovadas |
| Typecheck, lint, build e diff whitespace                                        | Aprovados                 |

O fluxo de banco/navegador valida abrir, preencher, fechar sem gravar, reabrir
sem rascunho antigo, salvar uma única assinatura e reabrir novamente sem
duplicação. Também valida edição futura, confirmação de cobrança e pagamento de
fatura. Testes de interface confirmam reenvio com os mesmos IDs após erro de
resposta, IDs novos em nova abertura e feedback/recuperação após falha de render.
Os testes de navegador finalizaram sem erros de página ou tráfego externo.

Comandos reproduzíveis no Cloud (Chromium instalado em `/usr/bin/chromium`):

```sh
npm ci
npm run test:unit
npm run test:db
npm run test:ui
npm run test:insecure-http
TEST_INSECURE_HTTP=1 npm run test:mobile
npm run test:subscriptions:mobile
npm run typecheck
npm run lint
npm run build
git diff --check
```

Relatórios e capturas locais, ignorados no Git:
`test-results/insecure-http/before.json`, `before.png`, `chromium/mobile.json`
e `integration-chromium/report.json`. O relatório inicial registra a exceção e
a raiz vazia na base `ec6109c`; os demais registram a validação da correção.

## Reteste no iPhone

1. Selecionar `codex/cheque-especial-consolidado` no notebook, atualizar com
   `git pull --ff-only`, executar `npm ci`
   e reiniciar a mesma prévia isolada na porta 5178 com a correção.
2. Reabrir/recarregar no Safari `http://192.168.100.165:5178`.
3. Em **Carteira → Assinaturas → Adicionar assinatura**, preencher dados
   sintéticos. Fechar e reabrir: o formulário deve abrir vazio e a navegação
   deve continuar funcionando.
4. Na prévia com banco descartável que permita escrita, preencher cartão,
   categoria, valor, dia e data; salvar. Deve existir uma assinatura, sem
   duplicação. Reabrir o formulário e testar fechamento pelo botão e pelo Safari.
5. Conferir também uma nova despesa, agendamento e aporte/resgate sintéticos.

O adaptador `experience-preview.mjs` é somente visual: rejeita salvamento por
projeto e mostra uma mensagem. Nesse modo, validar abertura/preenchimento e
feedback; o salvamento foi comprovado no Cloud com PGlite, não nesse adaptador.

## Limites e preservação

Safari/iPhone físico não foi validado. A instalação de WebKit no Cloud foi
bloqueada por HTTP 403 `Domain forbidden` nos hosts de download do Playwright.
O reteste físico segue pendente. O build mantém o aviso preexistente de bundle
acima de 500 kB.

As migrations 001–016 e o lockfile permanecem idênticos a `ec6109c`.
Nenhum dado de produção foi acessado ou alterado; nenhuma migration remota,
merge ou deploy foi executado. A branch continua com deploy automático
desabilitado em `vercel.json`; o commit usa `[skip vercel]`.

**PRONTO PARA RETESTE NO IPHONE: SIM.**
