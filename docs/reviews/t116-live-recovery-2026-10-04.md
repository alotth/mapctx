# T-116 — recuperação histórica real (2026-10-04)

Implementação com OpenCode + Z.ai GLM-5.3 Flash, revisão independente PASS nas attempts5/7/9 e integração validada no checkout principal. Escritas históricas somente via CLI; backup SQLite consistente e journal preservado antes da recuperação.

## Resultado final verificado

- **28 receipts corrigidos aditivamente (24 tarefas + 4 épicos)**: cada um agregava fontes estrangeiras comprovadas. Originais permanecem byte-idênticos e consultáveis; consumidores excluem os targets invalidados.
- **13 evidências aprovadas em 12 tarefas**: 6 measured e 7 inferred. Nove tarefas done receberam evidência sem reopen/claim/dispatch/receipt histórico novo.
- **Idempotência real**: repetição da aprovação resultou em 13 skipped, zero recorded/refused.
- Conferência da etapa inicial: todas130 projeções de tarefas originais e todos78 receipts originais byte-equivalentes. Conferência final das correções de épicos: todas132 projeções e todos80 receipts byte-equivalentes (antes de fechar T-116). T-106 conserva execução legítima de04Out; T-107/T-108 perdem actuals estrangeiros e continuam backlog.
- **Correções de épicos concluídas**: E-005/E-001/E-002/E-004 aceitas após patch mínimo e revisão independente PASS. Receipts/ciclo de vida desses épicos preservados; evidência nova continua restrita a T-*. Recusas retornam erro nonzero no CLI.

## Seleção e limites

Vínculos primários inequívocos medidos foram aprovados após conferir origem/comandos. Sessões com origem MapCtx e comandos não verificáveis entram somente como inferred, activeMs null. Nenhuma sessão com comando comprovadamente estrangeiro entrou. Sessões mistas a612/a617 foram excluídas. T-100/T-101 partilham referências relacionadas, mas sua origem/worker foi revisada e sua janela foi aprovada somente como inferred; isso não atesta tempo ativo nem conclusão.

| Tarefa | Harness / sessão | Tier aprovado |
| --- | --- | --- |
| T-083 | `codex:01a0908e-b9ac-75b3-9311-011263a0ba24` | measured |
| T-085 | `codex:01a092ce-6b51-7ad2-be0f-287cc7bbf630` | measured |
| T-086 | `codex:01a0972a-fd6e-7a32-a644-1851f35fea28` | measured |
| T-099 | `codex:01a0f4d6-9bd8-7793-8d54-95b3d4e1b170` | inferred |
| T-099 | `codex:01a0f4df-31b5-7c31-8cb9-0883a77e93b7` | inferred |
| T-109 | `codex:01a0f985-9bfb-7dc0-a660-93f04858e399` | inferred |
| T-090 | `opencode:ses_f1b2fc93dffewiZ5yKQnfsHF8O` | measured |
| T-091 | `opencode:ses_f1b1f5a4effer6j3cpSWaHhQYa` | inferred |
| T-093 | `opencode:ses_f1b0d8c47ffe7AGvNLNIxiPHz9` | measured |
| T-096 | `opencode:ses_f10b0edcbffe8DjRBN1v3KvBqn` | measured |
| T-102 | `opencode:ses_f06e207b0ffexIR54urtiTp2P4` | inferred |
| T-100 | `opencode:ses_f07194d4bffeCyqN3X5h56KkPK` | inferred |
| T-101 | `opencode:ses_f0702a0b6ffeJmegLKfb8GUZAj` | inferred |

Receipts válidos de execução têm prioridade nos actuals do roadmap. Evidências inferred são janelas e permanecem fora da calibração de duração. Tarefas sem evidência aprovada não são declaradas medidas: permanecem declared/synthetic/no-history conforme seus dados existentes. Reconstrução atual: {'measured': 6, 'inferred': 6, 'declared': 8, 'synthetic': 48, 'noHistory': 64}.

## Auditoria de receipts

| Dono | Target original | Fontes foreign comprovadas | Estado |
| --- | --- | --- | --- |
| T-065 | `10dd32fc-46eb-4b92-812a-c1159f5a02bf/1` | 9 | invalidado aditivamente |
| T-074 | `11abeb7c-ff17-4884-820d-6f331ffa8869/1` | 7 | invalidado aditivamente |
| T-107 | `1f9fdb89-91b9-4556-a0a4-c34a9ad22f5d/1` | 5 | invalidado aditivamente |
| T-068 | `205947e8-0528-44af-90f1-4a26e11e3cb9/1` | 3 | invalidado aditivamente |
| T-071 | `224058f6-f860-4928-8ca0-c75f0dd9fbae/1` | 7 | invalidado aditivamente |
| T-078 | `23a36f02-4c1c-49de-b6a8-03a10960141b/1` | 2 | invalidado aditivamente |
| T-108 | `291a3bd7-a04a-462f-a211-13fdce781802/1` | 6 | invalidado aditivamente |
| T-106 | `3fe099b4-99b4-49cd-93e9-769a3afbde62/1` | 3 | invalidado aditivamente |
| E-005 | `4b1b0c6a-fc85-4edb-b106-292ab7143b5a/1` | 3 | invalidado aditivamente |
| T-067 | `5c9beba3-067c-4f7a-95d9-804f9285daca/1` | 3 | invalidado aditivamente |
| T-090 | `64461726-eafd-4062-bcd4-017f90d1e35c/1` | 3 | invalidado aditivamente |
| T-084 | `73b3b305-271a-4919-a8d4-da51accee611/1` | 4 | invalidado aditivamente |
| E-001 | `7a3d26e4-aadd-4bd9-af4c-33f6f59fe856/1` | 3 | invalidado aditivamente |
| T-094 | `7c3391a9-0426-4574-9d07-69b284460213/1` | 4 | invalidado aditivamente |
| T-083 | `8f5fafac-8317-4960-9bb2-15deeef16eca/1` | 6 | invalidado aditivamente |
| E-002 | `8fd32040-74e4-41c6-8020-89f524da45b7/1` | 2 | invalidado aditivamente |
| T-095 | `937d5a58-eedb-4b8a-9ac5-249183a53c2f/1` | 2 | invalidado aditivamente |
| T-049 | `a9ca055b-07a6-4ccb-9b5e-c79628dc9112/1` | 43 | invalidado aditivamente |
| T-077 | `b081e0fa-1565-488a-9b80-6d3379f930da/1` | 3 | invalidado aditivamente |
| T-058 | `cb00c7d6-ddfb-4244-95d5-1b941cf21fe2/1` | 30 | invalidado aditivamente |
| T-070 | `d279c3ca-97e2-4372-9885-58842e9c5d3b/1` | 5 | invalidado aditivamente |
| E-004 | `d58c1472-b67c-45a2-94da-12b52e3f4912/1` | 30 | invalidado aditivamente |
| T-075 | `e15a14f2-61dd-4bd9-b231-27501bce185e/1` | 3 | invalidado aditivamente |
| T-076 | `e1dc6b2e-6373-46f2-9a54-68144c5107db/1` | 3 | invalidado aditivamente |
| T-096 | `e8073f5b-2129-47b8-9b30-0ca0f36da62a/1` | 4 | invalidado aditivamente |
| T-072 | `e8e14d4d-156f-4be1-a832-bad780f5b37a/1` | 6 | invalidado aditivamente |
| T-073 | `e9d0955c-25a8-4cea-bc73-56476f03215e/1` | 6 | invalidado aditivamente |
| T-057 | `ea92ed44-f1e9-4fd3-b5ec-3998ddcfe75d/1` | 10 | invalidado aditivamente |

## Pendências reais registradas

- [T-117](../../tasks/T-117.md), backlog em E-014: revisar candidatos restantes ambíguos/secundários e delimitar janelas mistas; ampliar recuperação só com origem/intervalo verificáveis.
- [T-118](../../tasks/T-118.md), backlog em E-014: defeito pré-existente de store repair no replay multi-node (`Cannot dispatch terminal task: T-090`), reproduzido antes de T-116. Nenhum repair real foi executado aqui.
- E-014 continua em andamento por T-117/T-118. Critérios de T-116 verificados; fechamento final via CLI registra seu próprio completedOn, sem alterar demais tarefas históricas.

## Validação

Build principal PASS; store137/sync104 após integração9, forecast63 e UI22 nas integrações anteriores; validate sem erros e sem drift. Warnings de datas bulk são anteriores à recuperação. Testes de CLI/source pin, atomicidade, idempotência, preservação de lifecycle, targets corretos, activeMs null e rótulos UI cobertos por [revisão independente](t116-independent-review.md).

## Verificação de consumidores no store real

- 28 keys invalidadas excluídas do forecast: 52 amostras válidas antes do receipt final da coordenação (80 originais menos28 invalidadas). T-106 mantém duas amostras legítimas; T-107/T-108 ficam com zero amostras/actuals de execução.
- Cache agregado:12 tarefas; inferred conserva activeMs null. Gantt usa receipt válido com prioridade; onde não há receipt válido, usa histórico aprovado com tier explícito. T-085 fornece span measured; T-086 conserva seu receipt válido.
- Fontes/ligações rejeitadas continuam consultáveis para auditoria, mas não alimentam actuals/calibração. Demais candidatos não aprovados estão registrados em T-117, sem inventar histórico.
- [Revisão das correções de épicos](t116-epic-corrections-review.md) e [implementação consolidada](t116-history-correction-2026-10-04.md) são documentos completos do repositório.
