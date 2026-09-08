# MapCtx Docs Workspace

This directory contains both authored Markdown docs for the repository and the static web docs assets used for the docs site.

## Recommended docs

- `docs/PROJECT.md` - living project context
- `docs/ROADMAP.md` - current delivery path and epic ordering
- `docs/methodology.md` - workflow baseline and selective adoptions
- `docs/thread-substrate.md` - portable task thread and run context contract
- `docs/adr/0003-vnext-planning-intelligence-and-storage.md` - accepted vNext boundary
- `docs/adr/` - durable methodological and architectural decisions
- `docs/releases/` - release runbooks

Authority is now `plansAuthority: store` (ADR 0003/0004): live state lives in
the external project store behind the `mapctx` CLI, and `TASKS.md` plus the
structured field blocks of `tasks/<ID>.md` are generated, read-only snapshots.
The `description:` prose blocks stay Git-authored durable intent.

## Current structure

```text
docs/
  PROJECT.md
  ROADMAP.md
  methodology.md
  thread-substrate.md
  adr/
  releases/
  index.html
  vercel.json
  README.md
```

## Notes

- `index.html` is the static docs-site entry point.
- The site content still has some legacy framing and should be aligned incrementally as methodology and terminology work lands.
- Prefer adding new durable guidance in Markdown files first, then mirror it into the site when the wording stabilizes.

## 🚀 Deploy to Vercel

### Option 1: Via CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Navigate to docs folder
cd docs

# Deploy
vercel
```

### Option 2: Via GitHub

1. Push this folder to your repository
2. Go to [vercel.com](https://vercel.com)
3. Import the repository
4. Configure:
   - **Root Directory**: `docs`
   - **Build Command**: (leave empty)
   - **Output Directory**: `.` (dot)
5. Deploy!

### Option 3: Via Web Interface

1. Go to [vercel.com](https://vercel.com)
2. Click "New Project"
3. Drag the `docs/` folder or upload it
4. Automatic deploy!

## 📁 Site Assets

```text
docs/
  index.html
  vercel.json
  README.md
```

## 🔧 Customization

Edit `index.html` to customize:
- Colors (CSS variables in `:root`)
- Content
- Sections
- Styles

## 🌐 Custom Domain

In the Vercel dashboard, you can:
1. Add a custom domain
2. Configure automatic SSL
3. Configure redirects if needed
