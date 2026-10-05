# Auditoria de atribuição do histórico — 2026-10-04

## Evidência confirmada

Consultados pelo CLI os receipts dos três dispatches abaixo. Todos têm executor `history-scan`, outcome `completed`, history tier `measured`, changedFiles limitado ao próprio detalhe da tarefa. Nenhum contém evidência de implementação de task start, plan execution ou stale scan no MapCtx.

| Task | Dispatch / attempt | Intervalo UTC | Sessão primária | cwd no session_meta |
| --- | --- | --- | --- | --- |
| T-106 | 3fe099b4-99b4-49cd-93e9-769a3afbde62 / 1 | 13–15 Set 2026 | 01a0a603-3d2a-71a1-b50e-56ee958ca9c6 | /Users/alt/repos/inlift/audit_financeiro |
| T-107 | 1f9fdb89-91b9-4556-a0a4-c34a9ad22f5d / 1 | 13–15 Set 2026 | 01a09850-8b47-7111-9fa8-58c62f23d191 | /Users/alt/repos/ela |
| T-108 | 291a3bd7-a04a-462f-a211-13fdce781802 / 1 | 15–17 Set 2026 | 01a0a705-77a2-7892-ac11-17dea6578d7d | /Users/alt/repos/inlift/audit_financeiro |

As três tasks foram criadas no MapCtx em 1 Out 2026. IDs T-* são locais ao projeto; coincidência textual não é identidade global. Receipt aceito não implica acceptance implementado.

## Pendências e decisão

- Preservar receipts originais. Não excluir, reescrever ou usar estes receipts para concluir T-106–T-108.
- T-106 recebe dispatch de implementação separado, com horários e arquivos desta execução. T-107/T-108 voltaram a backlog por eventos legais review → paused → backlog; execução completed histórica e receipts originais ficam preservados até correção auditável de T-116.
- T-116, filha de E-014, cobre isolamento por projeto, correção auditável e exclusão de evidência inválida, backfill de done sem mutar estado e reprocessamento aprovado.
- No snapshot anterior às mutações deste turno: 55 done não épicas, 0 com receipt de histórico, 14 com receipt de execução, 30 com posição sintética. Não declarar reconstrução completa.
- T-099 passa a filha de E-014 pelo CLI; dependências e receipts ficam preservados. E-014 continua doing enquanto T-116 está em aberto.

## Limite

Verificadas sessões primárias acima; não auditadas todas as sessões de todo o store. Correção de dados financeiros/forecast e backfill efetivo exigem T-116. Esta auditoria guarda somente IDs, caminhos e timestamps; nenhum conteúdo de conversa ou RunReceipt JSON entra no repositório.
