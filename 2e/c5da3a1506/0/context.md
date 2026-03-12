# Session Context

## User Prompts

### Prompt 1

fui usar o mapcs em outro projeto e tive erro, subiu duplicado, deu um timeout no processo, mas igual as informacoes do detail estarao abaixo, outra, ao enviar para e fazer o sync ele modificou o TASKS.md apagando informacoes importantes que existiam la, ao inves de alterar so os campos id e externalId.
tasks.md antes

### [T-032] Bug: 500 no upload de cupom sem log util (POST /api/cupons/upload)

- id: T-032
- status: backlog
- type: bug
- parent: null
- subIssueProgress: null
- priority: hi...

### Prompt 2

esse parser esta no @packages/sync-engine ou no @packages/core ? 
Called the Read tool with the following input: {"filePath":"/Users/alt/repos/mapctx/packages/sync-engine"}
<path>/Users/alt/repos/mapctx/packages/sync-engine</path>
<type>directory</type>
<entries>
.github/
.gitignore
AI_SKILL_DRAFT.md
CHEATSHEET.md
dist/
DOCUMENTATION.md
github-payload-examples.json
LICENSE
MAINTAINERS.md
mapcs.config.example.json
mapcs.config.json
mapcs.dev.json
node_modules/
package.json
README.md
src/
TASKS...

### Prompt 3

mas nao devia ser o mesmo parser?

### Prompt 4

esse parser tem o mesmo escopo no core e no sync? sera que foi feito isso de separar para facilitar criar o package?

### Prompt 5

acho que foi por causa da publicacao do package e para facilitar tudo, entao arrume e deixe mais flexivel o regex, tanto no core quanto no sync

### Prompt 6

e tambem arrume a questa do T-xxxx.md, pois agora tem o E-xxxx.md e podem ter outros formatos

### Prompt 7

pode ser

