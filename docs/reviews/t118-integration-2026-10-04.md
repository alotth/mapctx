# T-118 — Integração e verificação do store repair

Data: 2026-10-04. Executor: OpenCode / Z.ai GLM-5.3 Flash, tentativas 1–3. Coordenador: Codex, tentativa 4 do mesmo dispatch `0e976792-705a-4892-8f3a-7d350ae1322d`.

## Resultado e limite real

Código integrado no root após revisão independente PASS. Replay projeta fatos históricos sem revalidar regras atuais; novas escritas e API compartilham admissão de dispatch/receipt. Repair usa journal, watermarks e nós testemunhados pelo banco íntegro para detectar fontes incompletas antes do swap.

O store atual NÃO foi reconstruído. CLI integrado retornou exit 1 com `gap` na sequência 1 dos nós `23224427-9da8-458b-ab90-18ebadbb8613` e `e7fcd6bc-e08c-4155-8ee7-432085e80ada`. Banco e todos os dados permaneceram intactos. São linhas históricas DB-only em sequência 316/317, journal_path vazio; sequências anteriores ausentes impedem validar continuidade. Não se inventou journal, não se resequenciou nem se excluiu evento. Recuperação está registrada em [T-119](../../tasks/T-119.md), backlog, Hard/2d, depende T-118, sem claim/dispatch.

T-118 entrega correção do algoritmo e recusa segura de fontes incompletas. T-119 cobre recuperar a fonte incompleta do store real. E-014 permanece doing por T-117 e T-119.

## Evidência da recusa segura

Backup consistente via `node:sqlite backup` antes do comando, em `/tmp/mapctx-t118-integration/pre-repair`; consulta read-only exportou todas as tabelas e manifest de journal. Resultado público e stderr em `/tmp/mapctx-t118-integration/repair-real*`; snapshot posterior em `post-repair`.

| Verificação | Antes | Depois |
|---|---:|---:|
| Eventos indexados | 979 | 979 |
| Tarefas | 132 | 132 |
| Receipts | 84 | 84 |
| Evidências históricas | 13 | 13 |
| Correções históricas | 28 | 28 |
| Arquivos de journal | 977 | 977 |

Todas as tabelas idênticas em comparação integral, todos os hashes de journal iguais. SHA-256 do arquivo mapctx.db antes/depois: `b4940fcaee837b20760b0c076acaeabf7f58aa37b00ecf4e984aa2355a25a8e3`. Contagens são do instante de verificação, após claim da tentativa 4 e antes de criar T-119/fechar T-118; operações posteriores de lifecycle são esperadas e auditáveis.

T-069 permanece com drift preexistente (`unclaimed` no banco, `completed` no journal); recusa segura não o alterou. T-090 permanece review/completed, com receipts e reopens preservados.

## Revisão e validação

[Revisão independente completa](t118-independent-review-2026-10-04.md): PASS para implementação após corrigir P1 perda de nós DB-only e P2 admissão raw. [Relatório técnico](t118-repair-replay-2026-10-04.md) descreve fixtures RED→GREEN, determinismo, missing/corrupt DB, reindex, rollback, locks/WAL/swap e paridade receipt.

Root: `npm run build:sync-engine` PASS; store 152/152 e sync-engine 104/104 PASS; diff check PASS. Logs em `/tmp/mapctx-t118-integration/{build,store-tests,sync-tests}.log`. Código root corresponde aos seis arquivos de código revisados, sem alterações adicionais.

## Proveniência da integração

Sete arquivos de entrega (seis fontes/testes e documento) comparados com baseline capturado, não com HEAD; root ainda correspondia ao baseline antes da cópia. Original da tentativa 3 arquivado byte a byte em `/tmp/mapctx-t118-integration/attempt3-delivery`. Todos os sete hashes de receipt 3 foram verificados contra os arquivos originais.

Receipt 2 contém hash incorreto declarado, não usado como prova e não reescrito. Receipt 3 preserva hash do documento original: `51c747ac67ec58dca02fc6a4daf105887328db942e02082ae50222e3b92689fe`. Coordenador corrigiu status e três hashes antigos na nova versão do documento; receipt 4 referencia os digests dessa versão integrada. Documentação de review foi promovida integralmente, sem depender de Traycer para leitura do repo.

Nenhum arquivo staged/committed. Dirt anterior T-099–T-116 preservado; snapshots TASKS/estruturados são gerados pelo CLI. Mudanças de acceptance/links apenas nas descrições git-authored T-118 e E-014; T-119 criada pelo CLI.

Verificação final do board antes do fechamento: 133 tarefas, zero erros, drift false, três warnings antigos de bulk-updated-timestamp. Drift transitório de T-119 após criação foi regenerado por `mapctx reconcile T-119 --discard`, preservando descrição. Comparação dos 465 arquivos do baseline: nenhum removido ou symlink alterado; apenas os seis fontes, descrições E-014/T-118 e snapshot TASKS mudaram, além dos novos documentos e T-119.
