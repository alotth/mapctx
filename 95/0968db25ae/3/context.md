# Session Context

## User Prompts

### Prompt 1

estou pensando em uma nova skill, ao inves de blockear trazer o que acho que deve ser alterado e confirmar se pode alterar, copia da conversa abaixo 
"
Perfeito — vamos de **arquitetura leve** (sem enforcement forte de hook/CI).

Plano enxuto:


- **Objetivo**: quando você pedir para “subir commit”, a IA faz uma checagem de consistência entre mudanças de código e `TASKS.md` antes de commitar/push.
- **Mecânica**: criar uma **skill/comando de fluxo** (ex.: `/ship`) que:
  1. lê `git status` + ...

