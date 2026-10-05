# MapCtx 0.3.0 preparation and verification

Task T-122. Operator confirmed on 2026-10-05: CLI + browser workspace remain active; VS Code/OpenCode UI adapters move to a historical branch, no OLD folder.

## Preservation

`legacy/integrations-pre-0.3.0`, commit `c6c3efa9a9b3132a6f3ee4c7f6f1f5f8da51e773`, preserves the current source tree including reviewed T-099–T-121 delivery previously uncommitted. This snapshot is a preservation point, not a claim that every historical board item is complete. Two promoted test logs had temporary fixture lease tokens scrubbed before preservation; their manifests were updated.

## Active boundary

| Surface | Disposition | Reason |
| --- | --- | --- |
| CLI/store/planner/forecast/protocol/Traycer adapter | Kept | Current product and delivery protocol |
| workspaceV2 HTML/CSS/JS + roadmap tests | Moved into sync-engine | CLI web host depended on editor package; moved assets byte-identical |
| VS Code/OpenCode UI packages, exclusive dev/install tools and release workflows | Removed from main; preserved in historical branch | Explicit operator choice |
| Node/editor test dependencies | Removed from active lockfile | No active consumer |
| Store migrations, replay, receipts, historical session ingestion | Kept unchanged | Historical compatibility and data preservation |
| mapcs alias, Markdown adoption/compatibility, authored intent/docs | Kept | Still supported compatibility; not proven unused |

Root build/test now target maintained libraries, adapter, sync CLI and browser roadmap. Node engine is 22.13+; clean packaged smoke passed at that exact minimum and Node24. Public docs/site and release runbooks describe current distribution. Release workflow retains existing NPM_TOKEN credential path, adds tag/version check and full tests/pack smoke before publish. No unverified assumption of configured Trusted Publisher.

## Verification

- Root build PASS; full npm test **483/483**: adapter5, forecast63, planner12, protocol31, store219, sync+UI153.
- Clean isolated npm ci and full build PASS; no editor packages needed.
- Packed install PASS on Node24 and Node22.13: independently installed npm tarball, legacy init, explicit cutover, observed Acceptance import, canonical validate, final export/snapshot validation and authored note retention. HTTP HTML/JS/CSS served from installed package, without repo assets.
- Pack smoke first two runs exposed fixture omissions (pre-cutover config, then SHOW wrapper); script corrected, both final runs PASS. No product code modified to accommodate these mistakes.
- All three moved assets compare byte-identical to preserved source. Store/schema/history implementation unaffected by this cleanup.
- diff check PASS. Full logs and SHA256 manifest in assets/.

## Pending at preparation time

Independent review PASS: see independent-review.md. npm publication remains a separate gate at the time this preparation evidence is frozen; actual publication will be recorded in publication.md. No publication or planning completion is inferred from tests. Local npm account is unauthenticated. GitHub publication uses stored owner credentials per-command; global active account is left unchanged.
