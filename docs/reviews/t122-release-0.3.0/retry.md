# T-122 publication retry — 0.3.1

First tag sync-v0.3.0 remains immutable at 6002f1934dd0b73c9dac08337cd0508143fce125. Workflow37354285408 failed in adapter-traycer compilation before publication: adapter had no direct @types/node development dependency. Local and isolated temporary builds had access to ambient ancestor Node types; those prior successes did not prove complete declaration of this dependency. npm remained at0.1.1.

Fix: declare @types/node ^24.5.2 in adapter-traycer devDependencies, regenerate lockfile, candidate version0.3.1 and current install docs. No runtime source, schema, migration, UI asset, event or history logic changed. Root npm ci then483/483 full tests PASS. First receipt remains preserved; new claim/attempt2 uses same dispatch. Acceptance revision2 explicitly changes expected version and resets approvals.

Node22.13 runtime smoke from attempt1 is carried by runtime byte-identity; final0.3.1 tarball gets fresh Node24 smoke. Focal independent review and actual publication are recorded separately. Evidence logs/manifest in assets/.
