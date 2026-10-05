import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { acceptanceRenderObstruction, generateTaskDetailFile, parseTaskDetailFile, renderAcceptanceProse, renderAcceptanceProseUnowned } from "@mapctx/core"
import { approveAcceptanceCriterion, buildExport, createTask, reviseAcceptance, StoreHandle, upsertProject } from "./index"

/**
 * T-121: non-checkbox prose inside a real Acceptance section (notes,
 * evidence, links, authored plain lists) is Git-authored and must survive
 * store-authority export/checkpoint/push. Canonical criterion text/state
 * stays store-owned; the canonical checkboxes win over stale mirrors.
 */

const PROJECT_ID = "00000000-0000-0000-0000-00000000d121"

type Fixture = {
  repoDir: string
  handle: StoreHandle
  taskId: string
  detailPath: string
  writeDescription: (description: string) => void
  exportDetail: () => string
  close: () => void
}

function openFixture(description: string): Fixture {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-acceptance-prose-repo-"))
  const mapctxHome = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-acceptance-prose-home-"))
  const previousHome = process.env.MAPCTX_HOME
  process.env.MAPCTX_HOME = mapctxHome
  const storeDir = path.join(mapctxHome, "projects", PROJECT_ID)
  fs.writeFileSync(path.join(repoDir, "mapctx.toml"), [
    "schemaVersion = 1",
    `projectId = "${PROJECT_ID}"`,
    'plansAuthority = "store"',
    ""
  ].join("\n"), "utf8")
  const handle = StoreHandle.open(storeDir)
  upsertProject(handle.db, {
    projectId: PROJECT_ID,
    boardTitle: "Acceptance prose fixture",
    workDomains: [{ key: "CORE", description: "core" }],
    notesMarkdown: "",
    plansAuthority: "store",
    sourceSnapshotHash: null
  })
  const created = createTask(handle, { id: "T-001", title: "Prose preservation task", actor: "test", status: "review", workload: "Normal" })
  assert.equal(created.ok, true)
  const taskId = created.ok ? created.taskId : "T-001"
  const detailPath = path.join(repoDir, "tasks", "T-001.md")
  const writeDescription = (next: string) => {
    fs.mkdirSync(path.dirname(detailPath), { recursive: true })
    const current = fs.existsSync(detailPath) ? parseTaskDetailFile(fs.readFileSync(detailPath, "utf8")) : undefined
    fs.writeFileSync(detailPath, generateTaskDetailFile({
      id: taskId,
      role: current?.role ?? "implementation",
      impact: current?.impact ?? "medium",
      estimatedEffort: current?.estimatedEffort ?? "1h",
      estimatedEffortSource: current?.estimatedEffortSource,
      waitReason: current?.waitReason,
      prerequisites: current?.prerequisites ?? [],
      blocking: current?.blocking ?? [],
      filesAffected: current?.filesAffected ?? [],
      testsRequired: current?.testsRequired ?? [],
      summary: current?.summary ?? "Prose preservation fixture",
      description: next
    }), "utf8")
  }
  writeDescription(description)
  const exportDetail = () => {
    const exported = buildExport(handle.db, { tasksRoot: repoDir })
    const file = exported.taskDetailFiles.find(entry => entry.path === detailPath)
    assert.ok(file, "export must include the task detail file")
    return file.content
  }
  return {
    repoDir,
    handle,
    taskId,
    detailPath,
    writeDescription,
    exportDetail,
    close: () => {
      handle.close()
      if (previousHome === undefined) delete process.env.MAPCTX_HOME
      else process.env.MAPCTX_HOME = previousHome
      fs.rmSync(repoDir, { recursive: true, force: true })
      fs.rmSync(mapctxHome, { recursive: true, force: true })
    }
  }
}

const T063_CRITERIA = [
  "Provider remoto nao expoe automaticamente todas as suas tools.",
  "CLI como `gws` e operada por schema de operacao, nao por shell livre.",
  "Argumentos, resource scope, tamanho/paginacao, timeout, retry e circuit breaker sao aplicados por adapter.",
  "Resultado e tratado como dado nao confiavel e auditado."
]

// Byte-faithful description of ELA HEAD (fc3a5e2) tasks/T-063.md, extracted
// via the core parser. The independent-review note inside ## Acceptance is
// the durable prose T-303's checkpoint export lost.
const T063_DESCRIPTION = [
  "## Expected Outcome",
  "Gateway executa provider por capability declarada e nunca encaminha catalogo/credencial brutos ao modelo. MCP usa proxy; CLI usa worker isolado e operacoes allowlisted; API usa adapter normalizado.",
  "",
  "## Acceptance",
  "- [x] Provider remoto nao expoe automaticamente todas as suas tools.",
  "- [x] CLI como `gws` e operada por schema de operacao, nao por shell livre.",
  "- [x] Argumentos, resource scope, tamanho/paginacao, timeout, retry e circuit breaker sao aplicados por adapter.",
  "- [x] Resultado e tratado como dado nao confiavel e auditado.",
  "",
  "Revisao independente: `docs/engineering/traycer/reviews/T-063-gateway.md` (aprovada em `68bb02b`, integrada como `a371767`..`3b0734b`).",
  "",
  "## Open Decisions",
  "- [open] Politica de redacao/PII e estrategia de deteccao de prompt injection no retorno.",
  "",
  "## Nota de design (2026-09-09, review hermes-agent)",
  "Requisito adicional do health/probe de conexao MCP (fase 3): comparar `tools/list` do servidor remoto contra os `mcpTool` declarados no manifest aprovado. Tool extra nao declarada do lado do provider = health fail + alerta (drift de supply-chain), mesmo que o proxy nunca a chame — undeclared capability creep e tratado como incidente de seguranca. Referencia: politica \"declared capabilities must match reality\" do catalogo de plugins Hermes (`temp/hermes-agent/plugin-catalog/README.md`). Analise completa: artifact `capability-gateway-ela/hermes-capability-review`."
].join("\n")

test("T-121 regression (ELA T-063): authored review note inside Acceptance survives export in place", () => {
  const fixture = openFixture(T063_DESCRIPTION)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: T063_CRITERIA, actor: "author", expectRevision: 0 }).ok, true)
    const exported = fixture.exportDetail()
    const note = "Revisao independente: `docs/engineering/traycer/reviews/T-063-gateway.md` (aprovada em `68bb02b`, integrada como `a371767`..`3b0734b`)."
    assert.ok(exported.includes(note), "Git-authored note inside Acceptance must survive export")
    // Section relationship preserved: canonical Acceptance stays before the
    // sibling sections, exactly where it was authored.
    const acceptanceAt = exported.indexOf("## Acceptance")
    const openDecisionsAt = exported.indexOf("## Open Decisions")
    const designNoteAt = exported.indexOf("## Nota de design")
    assert.ok(acceptanceAt >= 0 && openDecisionsAt > acceptanceAt && designNoteAt > openDecisionsAt, "sibling sections keep their authored order after the Acceptance section")
    assert.ok(exported.includes("- [open] Politica de redacao/PII"), "sibling section content survives")
  } finally {
    fixture.close()
  }
})

test("T-121 regression: authored plain-bullet evidence list inside Acceptance survives export", () => {
  const description = [
    "## Acceptance",
    "- [x] Criterion one.",
    "- [x] Criterion two.",
    "",
    "- Evidência: commit `fe0c166`; spec \"every example in the skill template renders\".",
    "- Exceção de escopo (6b, 2026-09-25): pesquisa de referência sem implementação."
  ].join("\n")
  const fixture = openFixture(description)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Criterion one.", "Criterion two."], actor: "author", expectRevision: 0 }).ok, true)
    const exported = fixture.exportDetail()
    assert.ok(exported.includes("- Evidência: commit `fe0c166`; spec \"every example in the skill template renders\"."), "authored plain evidence bullet must survive (no canonical criterion matches it)")
    assert.ok(exported.includes("- Exceção de escopo (6b, 2026-09-25): pesquisa de referência sem implementação."), "authored plain exception bullet must survive")
  } finally {
    fixture.close()
  }
})

test("T-121 regression: interleaved evidence note keeps its position between its criteria", () => {
  const description = [
    "## Acceptance",
    "- [ ] Criterion A.",
    "Evidência do critério acima: link-a",
    "- [ ] Criterion B."
  ].join("\n")
  const fixture = openFixture(description)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Criterion A.", "Criterion B."], actor: "author", expectRevision: 0 }).ok, true)
    const exported = fixture.exportDetail()
    assert.ok(exported.includes("Evidência do critério acima: link-a"), "interleaved evidence note must survive")
    const aAt = exported.indexOf("- [ ] Criterion A.")
    const noteAt = exported.indexOf("Evidência do critério acima: link-a")
    const bAt = exported.indexOf("- [ ] Criterion B.")
    assert.ok(aAt >= 0 && aAt < noteAt && noteAt < bAt, "evidence note keeps its authored association between criterion A and B")
  } finally {
    fixture.close()
  }
})

test("T-121: legacy plain bullet that is a canonical criterion renders exactly once as a checkbox", () => {
  const description = [
    "## Acceptance",
    "- Legacy plain criterion.",
    "Nota autoral: registrada retroativamente em 03/10/2026 ao fechar a task."
  ].join("\n")
  const fixture = openFixture(description)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Legacy plain criterion."], actor: "author", expectRevision: 0 }).ok, true)
    const exported = fixture.exportDetail()
    assert.ok(exported.includes("- [ ] Legacy plain criterion."), "imported legacy plain bullet renders with canonical state")
    assert.equal(exported.split("Legacy plain criterion.").length - 1, 1, "criterion text appears exactly once (no duplication)")
    assert.ok(exported.includes("Nota autoral: registrada retroativamente em 03/10/2026 ao fechar a task."), "authored note survives")
  } finally {
    fixture.close()
  }
})

test("T-121: export is idempotent and canonical state wins over the stale mirror", () => {
  const description = [
    "## Acceptance",
    "- [x] Criterion A.",
    "Evidência: link-a",
    "- [ ] Criterion B.",
    "",
    "## Open Decisions",
    "Keep open."
  ].join("\n")
  const fixture = openFixture(description)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Criterion A.", "Criterion B."], actor: "author", expectRevision: 0 }).ok, true)
    // Mirror shows B pending; the store approved it afterwards.
    assert.equal(approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 1, expectRevision: 1, actor: "reviewer", evidence: { uri: "proof://b" } }).ok, true)
    const first = fixture.exportDetail()
    assert.ok(first.includes("- [x] Criterion B."), "canonical approved state must win over the stale mirror checkbox")
    assert.ok(first.includes("Evidência: link-a"), "authored evidence survives alongside canonical state")
    assert.ok(first.includes("Keep open."), "sibling content survives")
    const second = fixture.exportDetail()
    assert.equal(second, first, "export must be deterministic: same store + same prose, byte-identical output")
  } finally {
    fixture.close()
  }
})

test("T-121: nested headings and fenced examples inside Acceptance survive in place, idempotently", () => {
  const prose = [
    "## Acceptance",
    "- [ ] Criterion A.",
    "",
    "### Evidence",
    "Verificado em `docs/evidence/a.md`.",
    "",
    "Exemplo de formato esperado:",
    "```markdown",
    "## Acceptance",
    "- [x] fenced example ONLY",
    "```",
    "",
    "- [ ] Criterion B."
  ].join("\n")
  const items = [{ text: "Criterion A.", completed: false }, { text: "Criterion B.", completed: true }]
  const once = renderAcceptanceProse(prose, items, 3)
  assert.ok(once.includes("### Evidence"), "nested heading survives")
  assert.ok(once.includes("Verificado em `docs/evidence/a.md`."), "evidence prose survives")
  assert.ok(once.includes("## Acceptance\n- [x] fenced example ONLY\n```"), "fenced example survives byte-for-byte inside the section")
  assert.ok(once.includes("- [ ] Criterion A.") && once.includes("- [x] Criterion B."), "canonical state wins per criterion")
  const twice = renderAcceptanceProse(once, items, 3)
  assert.equal(twice, once, "render is idempotent over nested headings and fenced examples")
})

test("T-121: an unclosed fence inside the section refuses before publication", () => {
  const prose = [
    "Intro.",
    "",
    "## Acceptance",
    "- [ ] Criterion A.",
    "```markdown",
    "never closed"
  ].join("\n")
  const reason = acceptanceRenderObstruction(prose)
  assert.ok(reason !== null && reason.includes("never closed"), "in-section unclosed fence is an obstruction")
  assert.throws(() => renderAcceptanceProse(prose, [{ text: "Criterion A.", completed: false }], 1), /acceptance-render-refused/)
})

test("T-121: multiple real Acceptance sections refuse before publication", () => {
  const prose = "## Acceptance\n- [ ] A.\n\n## Notes\nN.\n\n## Acceptance\n- [ ] B."
  const reason = acceptanceRenderObstruction(prose)
  assert.ok(reason !== null && reason.includes("2 real Acceptance sections"), "multi-section prose is an obstruction")
  assert.throws(() => renderAcceptanceProse(prose, [{ text: "A.", completed: false }], 1), /acceptance-render-refused/)
})

test("T-121: duplicate legacy bullets consume the criterion once; the duplicate stays authored prose", () => {
  const prose = "## Acceptance\n- Legacy plain criterion.\n- Legacy plain criterion."
  const once = renderAcceptanceProse(prose, [{ text: "Legacy plain criterion.", completed: false }], 1)
  assert.equal((once.match(/^- \[ \] Legacy plain criterion\.$/gm) || []).length, 1, "criterion renders exactly once as a checkbox")
  assert.equal((once.match(/^- Legacy plain criterion\.$/gm) || []).length, 1, "the unmatched duplicate stays authored plain prose")
  const twice = renderAcceptanceProse(once, [{ text: "Legacy plain criterion.", completed: false }], 1)
  assert.equal(twice, once, "consume-once matching is idempotent")
})

test("T-121: a stale checkbox bullet that matches no current criterion is dropped (store owns the section)", () => {
  const prose = "## Acceptance\n- [x] Removed old criterion.\n- [ ] Current criterion."
  const once = renderAcceptanceProse(prose, [{ text: "Current criterion.", completed: false }], 2)
  assert.ok(!once.includes("Removed old criterion."), "stale managed checkbox is dropped")
  assert.ok(once.includes("- [ ] Current criterion."))
})

test("T-121 (attempt-4 P1): criteria added after a trailing authored note refuse (association is uncertain)", () => {
  // Counterexample to the attempt-3 contract "added criteria render before
  // the trailing note, which keeps its position": prose `- [x] A.` followed
  // by `Nota: evidência em docs/x.md.` and canonical [A,B,C] rendered
  // A,B,C,Nota — the note authored after A now trailed C, silently
  // reassociating it. Trailing prose has no reliable anchor, so the render
  // refuses and a human adjudicates the Git prose instead.
  const prose = "## Acceptance\n- [x] A.\n\nNota: evidência em docs/x.md."
  const items = [{ text: "A.", completed: true }, { text: "B.", completed: false }, { text: "C.", completed: false }]
  assert.throws(
    () => renderAcceptanceProse(prose, items, 2),
    /acceptance-render-refused/,
    "adding criteria behind a trailing authored note must refuse; the note's anchor becomes uncertain"
  )
})

test("T-121: criteria added with no authored prose after the first criterion render in place, idempotently", () => {
  const prose = "## Acceptance\n- [x] A."
  const items = [{ text: "A.", completed: true }, { text: "B.", completed: false }, { text: "C.", completed: false }]
  const once = renderAcceptanceProse(prose, items, 2)
  const aAt = once.indexOf("- [x] A.")
  const bAt = once.indexOf("- [ ] B.")
  const cAt = once.indexOf("- [ ] C.")
  assert.ok(aAt >= 0 && aAt < bAt && bAt < cAt, "missing criteria render contiguously after the last matched criterion")
  const twice = renderAcceptanceProse(once, items, 2)
  assert.equal(twice, once, "insertion is idempotent")
})

test("T-121: export refuses an in-section unclosed fence before any write", () => {
  const description = [
    "## Acceptance",
    "- [x] Criterion A.",
    "```markdown",
    "never closed"
  ].join("\n")
  const fixture = openFixture(description)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Criterion A."], actor: "author", expectRevision: 0 }).ok, true)
    assert.throws(() => fixture.exportDetail(), /acceptance-render-refused/)
    assert.equal(parseTaskDetailFile(fs.readFileSync(fixture.detailPath, "utf8")).description, description, "the Git-authored prose stays unmodified on refusal")
  } finally {
    fixture.close()
  }
})

test("T-121 F2: dropping a renamed/removed criterion strands adjacent evidence -> refuse before write", () => {
  const description = [
    "## Acceptance",
    "- [x] Criterion A.",
    "Evidence for A: link-a",
    "- [ ] Criterion B."
  ].join("\n")
  const fixture = openFixture(description)
  try {
    // Store revision no longer contains A (renamed away): dropping its
    // checkbox would leave "Evidence for A" pointing at B.
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Criterion B."], actor: "author", expectRevision: 0 }).ok, true)
    assert.throws(() => fixture.exportDetail(), /acceptance-render-refused/, "stranded evidence must refuse export before any write")
    assert.equal(parseTaskDetailFile(fs.readFileSync(fixture.detailPath, "utf8")).description, description, "Git prose stays unmodified on refusal")
  } finally {
    fixture.close()
  }
})

test("T-121 F3: checkbox-only reorder renders canonical order, idempotently", () => {
  const prose = "## Acceptance\n- [ ] A.\n- [ ] B."
  const once = renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4)
  const bAt = once.indexOf("- [ ] B.")
  const aAt = once.indexOf("- [ ] A.")
  assert.ok(bAt >= 0 && bAt < aAt, "canonical order B,A must win over stale prose order A,B")
  const twice = renderAcceptanceProse(once, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4)
  assert.equal(twice, once, "reorder render is idempotent")
})

test("T-121 F3: reorder with interleaved authored note refuses before publication", () => {
  const prose = "## Acceptance\n- [ ] A.\nEvidence for A: link-a\n- [ ] B."
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4),
    /acceptance-render-refused/,
    "reordering interleaved prose would reassociate the note; refuse"
  )
})

test("T-121 F3: reorder with preface-only authored prose keeps the preface and renders canonical order", () => {
  // The attempt-3 sibling test also pinned a trailing note ("Evidência
  // consolidada") staying LAST after the canonical B,A reorder — but in the
  // prose the note followed B, and after the reorder it followed A. That
  // silent reassociation is the attempt-4 P1; trailing prose is covered by
  // the refusal tests below. A preface (before the first criterion) has no
  // criterion association to lose, so it survives the swap.
  const prose = [
    "## Acceptance",
    "Seção revisada em 2026-10-05.",
    "- [ ] A.",
    "- [ ] B."
  ].join("\n")
  const once = renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4)
  const prefaceAt = once.indexOf("Seção revisada em 2026-10-05.")
  const bAt = once.indexOf("- [ ] B.")
  const aAt = once.indexOf("- [ ] A.")
  assert.ok(prefaceAt >= 0 && prefaceAt < bAt && bAt < aAt, "preface stays first, canonical order B,A")
  const twice = renderAcceptanceProse(once, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4)
  assert.equal(twice, once, "idempotent")
})

test("T-121 F3 (attempt-4 P1, reviewer repro 1): reorder with trailing evidence refuses before publication", () => {
  const prose = "## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md"
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4),
    /acceptance-render-refused/,
    "the trailing evidence followed B in the prose; after the B,A reorder it would follow A — refuse instead of reassociating"
  )
})

test("T-121 F3 (attempt-4 P1, reviewer repro 2): added criterion with trailing evidence refuses before publication", () => {
  const prose = "## Acceptance\n- [x] A.\nEvidence for A: docs/A.md"
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "A.", completed: false }, { text: "B.", completed: false }], 5),
    /acceptance-render-refused/,
    "inserting B after A would leave the evidence trailing the new criterion B — refuse instead of reassociating"
  )
})

test("T-121 F3: trailing fenced example with reordered criteria refuses before publication", () => {
  const prose = "## Acceptance\n- [ ] A.\n- [ ] B.\n```md\nexample for B\n```"
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4),
    /acceptance-render-refused/,
    "a fenced block after the last criterion is authored trailing prose; a reorder must not move it behind a different criterion"
  )
})

test("T-121 F3: trailing nested heading with reordered criteria refuses before publication", () => {
  const prose = "## Acceptance\n- [ ] A.\n- [ ] B.\n### Evidence for B\nkept"
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "B.", completed: false }, { text: "A.", completed: false }], 4),
    /acceptance-render-refused/,
    "a nested heading after the last criterion is authored trailing prose; a reorder must not move it behind a different criterion"
  )
})

test("T-121: owned criteria appended AFTER authored-only prose; no association is invented", () => {
  // No managed bullet anchors the section: the body is authored-only prose.
  // It stays in place as a preface and the canonical sequence is appended
  // after it. Moving the prose behind the criteria (the attempt-3 shape)
  // would present unassociated prose as trailing evidence of the last
  // criterion.
  const prose = "## Acceptance\nNota autoral: escopo fechado em 2026-10-05.\nDetalhes em docs/nota.md."
  const items = [{ text: "A.", completed: false }, { text: "B.", completed: false }]
  const once = renderAcceptanceProse(prose, items, 3)
  const notaAt = once.indexOf("Nota autoral: escopo fechado em 2026-10-05.")
  const detalhesAt = once.indexOf("Detalhes em docs/nota.md.")
  const aAt = once.indexOf("- [ ] A.")
  const bAt = once.indexOf("- [ ] B.")
  assert.ok(notaAt >= 0 && notaAt < detalhesAt && detalhesAt < aAt && aAt < bAt, "authored prose stays first; criteria append after it")
  const twice = renderAcceptanceProse(once, items, 3)
  assert.equal(twice, once, "idempotent")
})

test("T-121 F3: missing criterion with interleaved authored prose refuses (insertion would reassociate)", () => {
  const prose = "## Acceptance\n- [ ] A.\nEvidence for A: link-a\n- [ ] C."
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "A.", completed: false }, { text: "B.", completed: true }, { text: "C.", completed: false }], 5),
    /acceptance-render-refused/,
    "inserting B between A and C would push the evidence off its criterion; refuse"
  )
})

test("T-121 F4: matched nested bullet keeps its indentation and hierarchy", () => {
  const prose = "## Acceptance\n- [ ] Parent criterion.\n  - Child criterion.\n- [ ] Other."
  const items = [{ text: "Parent criterion.", completed: false }, { text: "Child criterion.", completed: true }, { text: "Other.", completed: false }]
  const once = renderAcceptanceProse(prose, items, 2)
  assert.ok(once.includes("  - [x] Child criterion."), `nested matched bullet must keep its indentation:\n${once}`)
  const twice = renderAcceptanceProse(once, items, 2)
  assert.equal(twice, once, "nested render is idempotent")
})

test("T-121 F4: reorder with indented (hierarchical) bullets refuses before publication", () => {
  const prose = "## Acceptance\n- [ ] Parent criterion.\n  - Child criterion."
  assert.throws(
    () => renderAcceptanceProse(prose, [{ text: "Child criterion.", completed: true }, { text: "Parent criterion.", completed: false }], 3),
    /acceptance-render-refused/,
    "reordering hierarchical bullets cannot preserve parentage without IDs; refuse"
  )
})

test("T-121 F1: unowned render preserves authored-only section and refuses stale checkboxes", () => {
  const authored = [
    "Intro.",
    "",
    "## Acceptance",
    "Critérios combinados com o operador; registro autoral.",
    "- Evidência planejada: docs/evidence-planned.md"
  ].join("\n")
  const once = renderAcceptanceProseUnowned(authored)
  assert.equal(once, authored, "authored-only unowned section is preserved verbatim, no marker invented")
  assert.equal(renderAcceptanceProseUnowned(once), once, "idempotent")

  const stale = "## Acceptance\n- [x] Stale criterion.\nEvidence: docs/evidence.md"
  assert.throws(() => renderAcceptanceProseUnowned(stale), /acceptance-render-refused/, "stale checkboxes in an unowned section refuse")

  const guarded = "## Acceptance\n<!-- mapctx:store-owned acceptance revision 9; generated by export; revise via `mapctx task acceptance` -->\nNota autoral restante."
  const cleaned = renderAcceptanceProseUnowned(guarded)
  assert.ok(!cleaned.includes("mapctx:store-owned acceptance revision"), "guard with nonexistent authority is dropped")
  assert.ok(cleaned.includes("Nota autoral restante."), "authored note survives the guard cleanup")
})

test("T-121 F1: export with canonical EMPTY revision preserves authored prose and refuses stranded evidence", () => {
  const authoredOnly = [
    "## Acceptance",
    "Registro autoral: fechada sem critérios executáveis.",
    "- Nota autoral de escopo."
  ].join("\n")
  const fixture = openFixture(authoredOnly)
  try {
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["Temporary."], actor: "author", expectRevision: 0 }).ok, true)
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "empty", texts: [], actor: "author", expectRevision: 1 }).ok, true)
    const exported = fixture.exportDetail()
    assert.ok(exported.includes("Registro autoral: fechada sem critérios executáveis."), "authored note survives export with empty canonical revision")
    assert.ok(exported.includes("- Nota autoral de escopo."), "authored plain note survives")
    assert.ok(!exported.includes("mapctx:store-owned acceptance revision"), "no invented marker for empty canonical criteria")
    const second = fixture.exportDetail()
    assert.equal(second, exported, "empty-revision export is byte-stable")
  } finally {
    fixture.close()
  }

  const stranded = "## Acceptance\n- [x] Doomed.\nEvidence for removed criterion: docs/evidence.md"
  const fixture2 = openFixture(stranded)
  try {
    assert.equal(reviseAcceptance(fixture2.handle, { taskId: fixture2.taskId, condition: "criteria", texts: ["Doomed."], actor: "author", expectRevision: 0 }).ok, true)
    assert.equal(reviseAcceptance(fixture2.handle, { taskId: fixture2.taskId, condition: "empty", texts: [], actor: "author", expectRevision: 1 }).ok, true)
    assert.throws(() => fixture2.exportDetail(), /acceptance-render-refused/, "stranded evidence refuses export under empty canonical revision")
  } finally {
    fixture2.close()
  }
})
