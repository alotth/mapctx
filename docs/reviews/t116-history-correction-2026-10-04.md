# T-116 — Correção auditável de histórico: implementação e verificação (2026-10-04)

**v9 — consolidado ao resultado final (attempts 1–9).** Implementação em
`mapctx-t116-history-correction-c40a6ceee67a` (worktree Traycer), ciclo de vida
no dispatch `d436d97c-23a1-49ae-bfef-57057674bbf9`: attempt 1 (claim
`489a1c33`), attempt 2 (claim `6296b454`, reprovada), attempt 3 (claim
`c5e34b47`, reprovada), attempt 4 (claim `9d40a6f6`, reprovada com 1 P2),
attempt 5 (claim `b241dbcf`, PASS do reviewer), attempt 6 (integração do
coordenador no root), attempt 7 (claim `4d2fe38e`, gaps do caminho live),
attempt 8 (coordenador: live recovery PARCIAL no root), attempt 9 (claim
`8f7ad007`, esta entrega: correção de receipts de epics + recusa CLI
nonzero). Este documento é livre de conteúdo de transcrição: somente IDs,
caminhos, timestamps, hashes e contagens. O relatório REAL do live recovery
do coordenador vive apenas no ROOT: `docs/reviews/t116-live-recovery-2026-10-04.md`.

## Delta final (atribuição vs. baseline de 457 hashes; receipts attempt≥3)

| Pacote | Arquivo | Mudança |
| --- | --- | --- |
| store | `src/schema.ts` | Migração 009: `history_evidence_projection` + `history_correction_projection` |
| store | `src/history.ts` (novo) | `recordHistoryEvidence` / `recordHistoryCorrection` (single-writer, idempotente); validação content-free estrita; correção aceita epics canônicos `E-*` (attempt 9) |
| store | `src/events.ts` | Eventos `history.evidence-recorded`, `history.correction-recorded` + appliers |
| store | `src/projections.ts` | Inserts/queries; `listInvalidatedReceiptKeys`; tipos |
| store | `src/db.ts` | `clearProjections` cobre as tabelas novas (rebuild) |
| store | `src/history.test.ts` (novo) | Testes de evidência/correção (validação estrita, idempotência, correção canônica) |
| forecast | `src/history-scan.ts` | Escopo por identidade de repositório; proveniência por comando (workdir/cd/repo-target, JS-source Codex); `degradedMeasuredSessions` |
| forecast | `src/history-scan.test.ts` | Fixtures cross-project, worktree, mixed-session, degradação |
| forecast | `src/store.ts` | Amostras de RECEITAS invalidadas saem de duração/calibração |
| sync-engine | `src/history-cli.ts` | Scan escopado; `--commit --approve` atômico all-or-nothing com pin de sourceHash; template de aprovação (exclui degradados por default; `--include-inferred` marca `intendedTier`); tier por elegibilidade POR SESSÃO (attempt 4); truncamento de proveniência → unverifiable (attempt 4); cache de datas: agregado inferred-only serializa `activeMs: null`, nunca 0, e inferred nunca é somado ao agregado numérico (attempt 5); `history correct`; `history reconstruct`; |
| sync-engine | `src/history-cli.test.ts` | 14 testes incl. repros review 2/3 |
| sync-engine | `src/gantt.ts` | `historySpan.tier` explícito no dataset; agrega bounds medidos de toda evidência aprovada |
| sync-engine | `src/mapctx-cli.ts` | Wiring `correct`/`reconstruct`/`--emit-approval-template`/`--include-inferred` (parse→options→historyScanCommand, attempt 7); gantt filtra receitas invalidadas |
| vscode-extension | `src/html/workspaceV2.js` | Timeline/tooltip preservam tier: evidência inferida rotulada "Inferred", nunca "Actual/Measured" (attempt 4) |
| docs | `docs/reviews/t116-history-correction-2026-10-04.md` | Este documento |

`TASKS.md`, `.mapctx/*` e `.git` são snapshots/runtime gerados pelo ciclo de
vida — fora do delta. Arquivos sujos pré-existentes (T-099..T-102, T-106)
preservados; nada commitado.

## Decisões finais

1. **Identidade de repositório, não ID textual.** Sessões só vinculam quando
   `cwd` resolvido (realpath + git toplevel + git common dir) casa com o
   repositório escaneado; worktrees do mesmo origin contêm. `cwd`
   ausente/inesistente = `unverifiable`; outro repo = `outOfScope`; ambos
   listados, nunca vinculados ou medidos.
2. **Proveniência por comando, não por sessão.** `workdir`/`cd` explícitos
   (incl. JS-source do Codex) e repo-target args (`git -C`, caminhos
   absolutos) são avaliados POR entrada; conflito de overrides →
   unverifiable; comando com ≥9 operandos de caminho fora-do-repo antes de
   qualquer target → proveniência TRUNCADA → unverifiable, nunca fail-open
   (review 3, finding 2). Entrada out-of-scope/unverifiable degrada a sessão:
   span vira `inferred`, sem tempo medido.
3. **Tier por elegibilidade por sessão (review 3, finding 1).** Evidência é
   `measured` somente quando a PRÓPRIA sessão é primária e contribuiu
   intervalos pós-grading. Tier task-wide nunca promove sessão degradada;
   `activeMs` de evidência inferida é `null`. Bounds medidos do cache
   agregam somente evidência measured — janela de sessão mista jamais expande
   bounds.
4. **Aprovação explícita, atômica, versionada.** Preflight completo, uma
   transação, rollback total em falha; sourceHash pinado (schema v2);
   degradados FORA do template por default; inclusão explícita exige
   `intendedTier: "inferred"` e declaração divergente recusa; re-run idêntico
   é no-op.
5. **Correção aditiva.** `history correct <uuid>/<attempt>` (canônico
   estrito) journaliza veredicto; originais byte-idênticos; leitores excluem
   invalidado; reprocessar reativa.
6. **Calibração não muda de mão.** Duração/acurácia do forecast continuam
   lendo RECEITAS (execução real); amostras de receitas invalidadas saem da
   calibração. `activeMs` de evidência HISTÓRICA alimenta o cache de datas e
   a exibição do roadmap — NÃO alimenta calibração de duração (sem consumer
   para isso; declarado explicitamente para não sugerir o contrário).
7. **UI honesta por tier.** Barra/tooltip de timeline carregam o tier:
   `measured` → "Actual / Measured session history"; `inferred` →
   "Inferred / Inferred session history — date window, not measured active
   time".
8. **Desconhecido nunca vira zero (review 4).** Agregado do cache de datas
   sem evidência measured contribuinte serializa `activeMs: null`; valor
   numérico só aparece de contribuição measured; inferred nunca entra na
   soma. Gantt encaminha o null (consumidores tratam ausência).
9. **Pin reflete a fonte real (review 5, live-audit).** (a) A flag de CLI
   `--include-inferred` é parseada e encaminhada de ponta a ponta
   (parse→options→historyScanCommand→template) — template default exclui
   degradados; opt-in marca `intendedTier: "inferred"`. (b) O sourceHash de
   sessões OpenCode deriva do CONTEÚDO (directory/title + toda row de
   message/part/session_input, ordenação canônica estável, payload digestado
   por sha256 — sem texto exposto, sem truncamento), nunca só do id:
   append/update/meta mudam o pin e aprovação velha aborta com zero writes;
   re-scan idêntico e ordem de inserção SQL não mudam o pin.
10. **Correção alcança epics; recusa é falha (live recovery).** (a) A
    validação de CORREÇÃO aceita ids canônicos `E-*` além de `T-*` —
    receipt de history-scan pode pertencer a um epic, e corrigir é
    veredicto de auditoria sobre receipt EXISTENTE e próprio, não execução
    do epic; todas as outras guardas (task existe, alvo
    `<uuid>/<attempt>` canônico, ownership, duplicata) inalteradas, e a
    gravação de EVIDÊNCIA continua restrita a `T-*`. (b) `history correct`
    recusado é comando FALHADO: mensagem de erro + exit nonzero (o corpo
    JSON ainda imprime antes, para tooling).

## Verificação final (attempt 9)

- Suítes: store 137, forecast 63, protocol 31, planner 12, sync-engine 104,
  UI roadmap 22 — todas verdes (369 testes).
- Live recovery do coordenador (attempt 8, ROOT — detalhes no doc root):
  PARCIAL — 24 de 28 receipts history-scan corrigidos aditivamente, 13
  evidências (6 measured / 7 inferred) em 12 tasks (9 done), re-run real
  idempotente (13 skipped / 0 recorded), 130 task rows e 78 receipts
  originais intocados, T-117/T-118 criadas como followups reais. Pendentes:
  4 correções de receipts owned por epics (E-005, E-001, E-002, E-004),
  bloqueadas pelo gap corrigido nesta attempt.
- Gap corrigido (attempt 9, repro fail-first com a mensagem real
  "invalid taskId: E-005"): validação de correção aceita `E-*` canônico;
  store test prova correção de receipt de epic com originais
  byte-idênticos (planning/execution/completedOn/receipt) e chave de
  invalidação ativa (alimenta Gantt/forecast); malformed (attempt 0),
  epic inexistente e owner errado continuam recusados com zero writes.
  E2e CLI em epic TERMINAL (`done`): correção não muta lifecycle,
  `history correct` recusado agora falha nonzero (duplicata via
  /already-corrected/ etc.).
- Gaps operacionais do caminho live (attempt 7, ambos repro fail-first):
  - `--include-inferred` IGNORADO pela CLI (achado na integração do
    coordenador): e2e via parser público — default exclui mixed,
    `--include-inferred` inclui com `intendedTier: "inferred"`. RED
    confirmado antes do wiring; help atualizado.
  - sourceHash OpenCode constante (`sha256("opencode:"+id)`) não protegia
    crescimento: pin novo deriva do conteúdo. Repro CLI/adaptor: template →
    append de part → hash muda → commit com pin velho recusado (/source
    changed/) com ZERO evidência/correção/journal e lifecycle intacto;
    update de title também move o pin; re-scan idêntico mantém o pin;
    ordem de inserção SQL (duas bases, ordens opostas) NÃO muda o pin.
    RED confirmado com a fórmula antiga restaurada temporariamente.
- Repro review 4 (fail-first confirmado: cache inferred-only dizia
  `activeMs: 0`): agora evidência inferred-only → cache e Gantt
  `activeMs: null`; agregado misto (measured+inferred) permanece numérico e
  igual à soma SOMENTE das contribuições measured; agregado measured válido
  intacto. Gantt já encaminhava null (`activeMs ?? null`); o fabricava o 0
  na serialização do cache — corrigido na fonte.
- Repros review 3 (fail-first confirmado antes do fix):
  - finding 1: sessão mista aprovada sem intenção → recusa "requires
    explicit inferred intent", zero writes; com intenção → linha `inferred` /
    `activeMs null`; bounds medidos do cache = somente sessões limpas;
    `intendedTier` em link elegível a measured → recusa.
  - finding 2: 8 caminhos existentes fora-de-repo + `git -C <foreign> …
    T-201` → entrada unverifiable, T-201 jamais vinculado.
  - finding 3: barra inferida renderiza "Inferred session history",
    `/>Actual</` ausente; measured permanece "Actual / Measured session
    history".
- Scan real read-only (`--task T-106,T-107,T-108`, 0 erros, v6): 3023
  foreign + 617 unverifiable command overrides (truncamento conservador
  elevou 149→617); 4 sessões vinculadas degradadas (`01a0a612…`, `01a0a617…`,
  `01a1050d…`, `ses_f06c1936`); template de aprovação default = 0 candidatos
  para estas tasks — nada é commitável sem intenção explícita. a603/9850/a705
  permanecem out-of-scope, nunca vinculadas.
- Efeito conservador do truncamento (para decisão do coordenador): a sessão
  OpenCode com trabalho MapCtx genuíno no worktree (`ses_f06c1936`) caiu de
  measured (v5) para inferred (v6) porque comandos longos com muitos
  operandos de caminho agora truncam → unverifiable. Alternativa futura (fora
  do escopo): inspecionar argumentos estruturados sem cap perdedor.
- Cópia isolada (MAPCTX_HOME em /tmp, attempts 2–3): 8 evidências aprovadas,
  3 correções de receitas inválidas, receitas byte-idênticas ao backup,
  planning/completedOn das 130 tasks intactos, T-106 segue `done`, re-run
  no-op, replay de journal ok, canários de privacidade ok.

## Pendências para o coordenador (pós-attempt 9)

1. Re-review independente do patch attempt 9 (delta pequeno: store/history.ts
   + testes + doc); em PASS, integrar no root e executar as 4 correções de
   epics agora desbloqueadas (E-005, E-001, E-002, E-004) — sempre com os
   originais preservados.
2. `history reconstruct --json` final como relatório aprovado (criterion 6).
3. Decidir política para sessões truncadas (aceitar inferred com intenção vs.
   evoluir para parsing estruturado sem cap).
4. Conhecido pré-existente (fora do escopo T-116): `store repair` falha ao
   reproduzir journal multi-node ("Cannot dispatch terminal task: T-090");
   reproduz no backup pré-T-116 com o CLI antigo; não é regressão.

---

## Apêndice — histórico cronológico

### Attempt 1 (claim `489a1c33`) — entrega original

- Migração 009; evidência/correção como eventos próprios, sem mutação de
  ciclo de vida (done mantém planning/completedOn); `--commit` exige
  `--approve`; escopo por identidade de repositório.
- Store real: apenas migração 009 aditiva via `store init` (backup verificado
  em /tmp; 869 eventos, 72 receitas, 130 tasks idênticos antes/depois).
- Cópia isolada: aprovação T-106 (4 sessões) + T-107/T-108 (2 secundárias
  cada) → 8 evidências; 3 correções; T-106 permanece done.
- Suítes então: store 134, forecast 58, protocol 31, planner 12,
  sync-engine 93.
- O caminho antigo de commit (claim → dispatch → receipt, que promovia tasks
  e pulava terminais) foi removido nesta attempt.

### Review attempt 2 — finding 1 (a612/a617)

Root cause do link residual de a617: input `exec` do Codex é JS-source
(`tools.exec_command({cmd, workdir})`), não JSON — `workdir`/`cwd` e `cd`
quotado nunca eram parseados e comandos em workdir estrangeiro ficavam
in-scope. Fix: `extractCommandWorkdir` lê chaves JS-source e `cd` quotado;
overrides divergentes numa entrada → unverifiable; workdir in-scope não
desculpa texto de comando que mira outro repositório. Scan real (v5):
a617/a612 linked apenas por comandos MapCtx genuínos, degradados a inferred,
sem tempo medido; 3023 foreign + 149 unverifiable. Aberto para o coordenador:
span inferido de a617 cobre a janela inteira da sessão, não só comandos
in-scope.

### Attempts 2–3 (claims `6296b454`, `c5e34b47`) — review 2/3 sanções

Strict validation content-free (datas ISO, spans positivos ordenados, bounds
pareados, activeMs finito ≥0 limitado, enum de signals, payload
canonizado — canários sem mutação); alvo de correção canônico estrito
`<uuid>/<attempt>`; aprovação atômica com preflight/rollback; sourceHash pin
(schema v2) + `--emit-approval-template`; cache agregado por task com tiers +
gantt/VM; `--include-inferred` e tier por sessão chegam no attempt 4.

### Attempt 4 (claim `9d40a6f6`) — review 3 sanções + review 4 P2

Tier por sessão + intent gate + template default-excludes; truncamento de
proveniência fail-closed; UI tier honesto. Review 4 validou tudo anterior
(PASS) e reprovou por um P2: serialização `activeMs ?? 0` convertia
agregado inferred-only em zero. Fix no attempt 5.

### Attempt 5 (claim `b241dbcf`) — PASS do reviewer; integração no attempt 6

Null-preservation no cache (desconhecido nunca vira zero). Reviewer PASS;
coordenador integrou os 17 files no root (attempt 6, lease próprio,
suítes root verdes, nenhuma história real gravada) e achou dois gaps
operacionais no caminho live, corrigidos no attempt 7.

### Attempt 8 (coordenador) — live recovery PARCIAL no root

24/28 receipts history-scan corrigidos aditivamente; 13 evidências (6
measured / 7 inferred) em 12 tasks (9 done); re-run real idempotente (13
skipped / 0 recorded); 130 task rows + 78 receipts originais intocados;
T-117/T-118 criadas como followups. Bloqueado em 4 correções de receipts
owned por epics (E-005/E-001/E-002/E-004): "invalid taskId E-005".
Relatório real: `docs/reviews/t116-live-recovery-2026-10-04.md` (ROOT).

### Attempt 9 (claim `8f7ad007`) — correção de epics + recusa nonzero

Validação de correção `/^[TE]-\d{1,4}$/` (evidence continua `T-*`);
`history correct` recusado agora é exit nonzero (JSON ainda impresso).
Store test: correção de receipt de epic com originais preservados e
malformed/unknown/wrong-owner recusados; e2e CLI em epic terminal.
Suítes: 369 verdes.

## Closeout da coordenação — recuperação real concluída

Patch attempt9 integrado; revisão independente PASS. CLI aplicou as quatro correções de épicos restantes:28/28 receipts contaminados invalidados aditivamente. Aprovação real registra13 evidências em12 tarefas (6 measured,7 inferred), incluindo9done; re-run13skipped0recorded. Correções finais preservaram132tarefas e80receipts byte-equivalentes. T-106 legítima preservada, T-107/T-108 permanecem backlog e sem actuals estrangeiros. Store137/sync104 do checkout principal PASS, cache/Gantt/forecast conferidos. [Relatório completo](t116-live-recovery-2026-10-04.md). T-117/T-118 backlog em E-014 rastreiam candidatos ambíguos e repair pré-existente; essas pendências não são declaradas entregues pela T-116.

As seções de handoff acima descrevem o estado no momento de cada entrega; pending/live passos nessas seções foram cumpridos neste closeout. Fechamento de T-116 é feito pelo CLI após atualizar critérios; nenhuma tarefa histórica foi reaberta.
