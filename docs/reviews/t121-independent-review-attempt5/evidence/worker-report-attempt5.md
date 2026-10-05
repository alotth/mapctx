# T-121 — Preservação de prosa Git-authored dentro de Acceptance

## Estado e proveniência

T-121 segue `review`; nenhum critério Acceptance foi aprovado por este worker, e nenhuma conclusão `done` foi aplicada. O review independente attempt 3 encontrou P1: reorder ou inclusão canônica podia reassociar evidência Git-authored ao último critério.

Attempt 4 teve execução parcial anterior à sessão atual. A correção conservadora de trailing prose e testes do renderer já estavam no worktree ao início desta sessão; não são atribuídos a este worker. A análise Codex `gpt-6.1-sol` anterior também foi somente leitura. Esta conclusão é attempt 5 no dispatch existente `c8adf88f-bc41-41ed-8719-5eadbbe2c844`, executada por Codex `gpt-6-luna`, high, após autorização explícita do usuário para continuar com Luna. Claim iniciado em `2026-10-05T15:08:30.331Z`; claim ID `70779fe3-e89e-48f8-a5f0-5d8585fca6d9`. O token permaneceu fora do repositório e deste documento.

A baseline inválida anterior do attempt 4 não foi usada nem reconstruída retroativamente. Uma baseline honesta pós-análise/pré-completion foi gravada em `/tmp/mapctx-acceptance-prose-preservation/baseline-session-codex-luna-precompletion.json`: hashes dos oito arquivos focais e digest/contagem do status do worktree naquele momento. `checkpoint.test.ts` já estava untracked e foi identificado como arquivo focal depois da baseline; seu hash pré-edição não foi registrado. Não representa hashes completos de todos os arquivos sujos nem comparação byte-a-byte de toda baseline.

## Contrato e correção

- Store continua dono de texto, estado e ordem canônicos dos critérios; Git continua dono de notas, links, evidências, exemplos e demais linhas autorais.
- Quando ordem ou inclusão de critérios muda, qualquer linha autoral não vazia após o primeiro critério causa recusa se a associação não pode ser provada. Isso inclui notas finais, fences, headings, listas e evidência que pareça semanticamente vinculada. Não há heurística semântica.
- Recusa de checkbox órfão agora orienta preservar e adjudicar a nota: reancorar em critério atual ou movê-la para seção Git-authored própria fora de Acceptance. Revisar critérios canônicos é decisão separada. A mesma regra vale para checkbox sem revisão canônica: adotar explicitamente ou preservar o registro completo fora de Acceptance com evidência reancorada. Nunca apagar evidência nem restaurar critério só para liberar render.
- Não houve mudança de schema, parser de import, aprovação, histórico de revisões, lifecycle, GitHub real ou ELA real.

## Delta desta sessão

- `packages/core/src/task-detail.ts`: remédio de recusa substituído por orientação de preservação/reancoragem segura.
- `packages/sync-engine/src/checkpoint.test.ts`: regressões via CLI pública para ambos os repros — `A, B, Evidence for B` com canônico `B, A`; e `A, Evidence for A` com critério novo `B`. Ambas exigem recusa em `stage: build`, lista `publishedFiles` vazia, hashes dos arquivos do repo iguais e store sem drift em eventos, checkpoints, clock ou metadata.
- `packages/sync-engine/src/push-store.test.ts`: os mesmos repros contra push store-backed, `gh` mockado, zero chamadas remotas.
- `tasks/T-121.md` recebe link para esta documentação e o manifesto durável da prova; bloco estruturado do snapshot não foi alterado.
- Código/testes já presentes para a proteção do renderer não foram reatribuídos ao attempt 5.

## Validação desta sessão

| Comando | Resultado |
|---|---|
| `npm run build:sync-engine` | PASS; exit code 0 |
| `npm run test:store` | PASS; 219/219 |
| `npm run test:sync-engine` | PASS; 131/131 |
| CLI pública `mapctx export` trailing-evidence regressions | PASS nos dois casos, incluídos na suíte sync-engine |
| Push mockado trailing-evidence regressions | PASS nos dois casos; 0 chamadas `gh`, incluídos na suíte sync-engine |

Logs completos ficam fora do Git em `/tmp/mapctx-acceptance-prose-preservation/`: `build-codex-luna-final.log`, `store-suite-codex-luna-final.log` e `sync-suite-codex-luna-final.log`. Os totais 213/213 e 129/129 de reviews anteriores são históricos, não resultados desta sessão.

## Recuperação de prova em cópia isolada

A prova utilizou somente cópia temporária de `mapctx.toml`, `TASKS.md`, `tasks/` e store. O HEAD ELA foi pinado antes e depois em `9933dd5c8326b7ac3fe8136fc8f6eea70b7df212`; os hashes dos 15 arquivos T-121 foram idênticos antes/depois na origem real. A fonte de prosa perdida foi pinada ao commit de incidente `fc3a5e2`. Nenhuma escrita, export, reset ou commit ocorreu no ELA real.

Na cópia, a prosa Acceptance faltante foi composta da fonte incidente com o texto atual fora de Acceptance, as notas Acceptance atuais e os critérios/estados canônicos atuais do store. Para os 15 alvos — T-063, T-175, T-180, T-186, T-187, T-194, T-212, T-213, T-248, T-254, T-257, T-261, T-268, T-271 e T-274 — a prova confirmou:

- 226 linhas autorais não vazias preservadas: 172 que já estavam no working tree atual e 54 Acceptance autorais recuperadas da fonte incidente;
- texto, revisão, estados, evidências e aprovações dos critérios canônicos sem mudança;
- prosa atual fora de Acceptance byte-estável;
- dois `mapctx export --reason manual --json` públicos bem-sucedidos e idempotentes, com 318 arquivos no manifesto e hashes path/hash iguais (319 arquivos totais na cópia, incluindo `mapctx.toml`);
- store da cópia avançou clock 3207→3209 e adicionou exatamente dois eventos `checkpoint.exported` e dois checkpoints. Só `event_log`, `export_checkpoint` e `store_meta` mudaram; tabelas de domínio não mudaram.

**Limite observado:** o primeiro checkpoint da cópia atualizou 293 arquivos de espelho, além da recuperação Acceptance focal, porque snapshots ELA já divergiam do store em outros tasks/status. Isso ocorreu só na cópia. A prova não autoriza publicar essa atualização ampla no ELA; o coordenador deve revisar o delta antes de qualquer recuperação real.

Manifesto completo de 318 paths/hashes e pins desta prova está em [copy proof](t121-acceptance-prose-preservation-2026-10-05.copy-proof.json). Resumo local está em `/tmp/mapctx-acceptance-prose-preservation/codex-luna-ela-copy-JCj7wp/proof-summary.json`; a cópia, store clonado e log também ficam sob esse diretório temporário. Esses caminhos são evidência da sessão local, não dependência de runtime do repositório.

## Próxima etapa

Worktree congelado para review independente do delta cumulativo desde attempt 3 e da conclusão attempt 5. A claim foi iniciada no dispatch existente e deve ser liberada após receipt/readback. Só após PASS independente o coordenador decide recuperação real do ELA, com diff revisável dos 15 caminhos e atenção ao drift mais amplo do checkpoint. Nenhuma aprovação de acceptance, `done`, escrita ELA real, ação GitHub, stage ou commit foi executada por esta sessão.
