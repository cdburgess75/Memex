# Memex

A personal, LLM-maintained wiki in a single HTML file.

Most LLM + document setups are retrieval-only: you upload files and the model
re-discovers the answer from scratch on every question. Nothing accumulates.
Memex is different — it **builds and maintains a persistent, interlinked wiki**
that sits between you and your raw sources. You curate and ask; Claude does the
reading, summarizing, cross-referencing, and bookkeeping.

The whole app is one file. No build step, no server, no dependencies to install.
Your wiki saves to your browser's local storage.

**Live app:** https://cdburgess75.github.io/Memex/

## Three motions

- **Ingest** — paste an article, paper, or note. Claude reads it, writes a
  summary, and creates or updates interlinked wiki pages.
- **Query** — ask anything. Claude answers from what you've gathered, and can
  file the answer back as its own page so insight compounds.
- **Lint** — periodically audit the collection for contradictions, orphaned
  pages, missing cross-references, and gaps worth chasing.

## Run it

Either open the hosted app above, or run it locally:

1. Open `index.html` in any browser.
2. Click **Settings** and paste an [Anthropic API key](https://console.anthropic.com/settings/keys).
3. Go to **Ingest** and feed it your first source.

Your key is stored only in your browser and sent directly to Anthropic — nothing
is bundled into this repo and there is no backend. Ingesting and querying bill
your own API account.

## Hosting

This repo deploys to GitHub Pages automatically. Every push to `main` publishes
to https://cdburgess75.github.io/Memex/ via the workflow in
`.github/workflows/pages.yml`.

To enable it once: repo **Settings → Pages → Build and deployment → Source →
GitHub Actions**.

## Portability

- **Export .md** — dumps the entire wiki as a single markdown bundle, ready to
  drop into Obsidian or a git repo.
- **Backup / Restore** — full JSON export and import to move your wiki between
  machines.

## Credit

The pattern comes from the `llm-wiki` idea, itself a descendant of Vannevar
Bush's 1945 "Memex" — a private, curated knowledge store with associative trails
between documents. Bush couldn't solve who does the maintenance. An LLM can.

## License

MIT — see [LICENSE](LICENSE).
