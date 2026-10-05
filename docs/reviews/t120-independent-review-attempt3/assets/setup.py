import os,json,hashlib,shutil,difflib
from pathlib import Path
src=Path('/Users/alt/.traycer/worktrees/alotth__mapctx/mapctx-t120-store-validation-checkpoints-1a98d97e12eb'); root=Path('/Users/alt/repos/mapctx'); out=Path('/tmp/mapctx-t120-review-attempt3'); code=out/'code'
B=Path('/tmp/mapctx-t120-baseline')
before=json.loads((B/'worktree-manifest.json').read_text()); after=json.loads((B/'review-attempt3-start-manifest.json').read_text()); delta=json.loads((B/'review-attempt3-delta.json').read_text()); code.mkdir(exist_ok=True)
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
checks={'frozen':[],'baseline':[],'symlinks':[]}; diffs=[]
for n,meta in after.items():
 p=src/n; q=code/n; q.parent.mkdir(parents=True,exist_ok=True)
 if meta['kind']=='file':
  checks['frozen'].append([n,h(p)==meta['sha256']]);shutil.copy2(p,q)
 elif meta['kind']=='symlink':
  checks['symlinks'].append([n,os.readlink(p)==meta['target'],os.readlink(p),(before.get(n) or {}).get('target')])
 else: print('nonfile',n,meta)
for n,meta in delta.items():
 p=root/n; old=meta['before']; good=old is None or (p.exists() and h(p)==old['sha256']); checks['baseline'].append([n,good])
 if good:
  oldtext='' if old is None else p.read_text();newtext=(src/n).read_text(); diffs.extend(difflib.unified_diff(oldtext.splitlines(True),newtext.splitlines(True),fromfile='before/'+n,tofile='after/'+n))
 else: print('baseline mismatch',n)
(code/'node_modules').mkdir(exist_ok=True)
for p in (src/'node_modules').iterdir():
 if p.name in ['@mapctx','.bin']:continue
 os.symlink(p,code/'node_modules'/p.name)
(code/'node_modules/@mapctx').mkdir(exist_ok=True)
for p in (code/'packages').iterdir():
 if (p/'package.json').exists():
  name=json.loads((p/'package.json').read_text())['name']
  if name.startswith('@mapctx/'):os.symlink(p,code/'node_modules'/name)
(code/'node_modules/.bin').mkdir(exist_ok=True)
os.symlink(src/'node_modules/typescript/bin/tsc',code/'node_modules/.bin/tsc')
for p in (src/'packages').iterdir():
 if (p/'node_modules').exists():
  for child in (p/'node_modules').iterdir():
   if child.name in ['@mapctx','.bin']:continue
   target=code/'packages'/p.name/'node_modules'/child.name;target.parent.mkdir(parents=True,exist_ok=True);os.symlink(child,target)
(out/'attributable.diff').write_text(''.join(diffs));(out/'setup-checks.json').write_text(json.dumps(checks,indent=2))
print('copied',len(after),'frozen match',sum(c[1] for c in checks['frozen']),'of',len(checks['frozen']),'| baseline match',sum(c[1] for c in checks['baseline']),'of',len(delta),'| symlinks',checks['symlinks'])
