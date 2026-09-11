# Vendored skills

Interface skills from [jakubkrehel/skills](https://github.com/jakubkrehel/skills) — typography,
color, layout, accessibility, UI polish and product writing — copied into the repo so every clone
gets them with no install step.

Upstream is also distributed as a Claude Code plugin (`/plugin marketplace add jakubkrehel/skills`).
Declaring that marketplace in `.claude/settings.json` would not have been enough: a plugin from an
external source still has to be installed on each machine before its skills load, so a teammate who
never ran the install would silently not have them. A vendored copy loads from the repo itself.

## What is here

| Skill | Use it for |
|-------|-----------|
| `better-ui` | Radius, surfaces, optical alignment, icons, animation |
| `better-typography` | Type scale, spacing, wrapping, truncation, OpenType |
| `better-colors` | Palettes, semantic tokens, formats, measured contrast |
| `better-accessibility` | Keyboard, focus, screen readers, forms, hit areas |
| `better-layout` | Grouping, alignment, reading order, adaptivity |
| `better-writing` | Product copy, error messages, consistency |
| `better-interface` | Runs all six `better-*` skills as one review |
| `interface-review` | Reviews a change (diff, branch, PR) rather than a screen |
| `explain-interface` | Works out how a piece of web UI was built |
| `break` | Renders one component in every state on a scratch page |
| `variant` | Builds three deliberate variants behind a picker |

The last four are user-invoked (`/break`, `/variant`, …); the rest the model may reach for on its own.

## Applying them to Depot

These skills are written for a generic project with a styling system and a build step. This repo has
neither, so two of their defaults need translating:

- **Color is not free.** The skills will offer to generate a palette. Depot ships five curated
  schemes (`:root` / `html[data-scheme="…"]`, light and dark), and the accent is reserved for
  actions, selection, focus and links. Work inside those tokens; do not introduce a new color.
- **No Tailwind, no build.** `better-typography/css-cheat-sheet.md` maps declarations to Tailwind
  classes — read the CSS column. Every fix lands in the single `<style>` block in `index.html`.

## Re-syncing

Upstream pinned at [`267330e`](https://github.com/jakubkrehel/skills/commit/267330e1adfc66a718fb65fa6918c1f06d0a689e)
(2026-08-29, plugin version 1.6.3). To pull a newer copy, from the repo root:

```bash
tmp=$(mktemp -d) && git clone --depth 1 https://github.com/jakubkrehel/skills "$tmp"
rm -rf .claude/skills/*/
cp -R "$tmp"/skills/. .claude/skills/
find .claude/skills -type d -name agents -prune -exec rm -rf {} +   # opencode/OpenAI metadata, unused here
cp "$tmp"/LICENSE .claude/skills/LICENSE
rm -rf "$tmp"
```

Then update the pin above. The copy is verbatim apart from the dropped `agents/` directories, so a
re-sync is a plain overwrite — keep local edits out of these files and put project-specific guidance
in `CLAUDE.md` instead.

MIT, © Jakub Krehel — see `LICENSE`.
