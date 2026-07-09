# andyrogers.design

A lean, fast portfolio site built with [Astro](https://astro.build). Content is written in
Markdown; the site turns it into styled pages. Hosted free on Netlify.

## Run it on your machine

```bash
npm install      # once, to fetch dependencies
npm run dev      # start a local preview at http://localhost:4321
npm run build    # produce the final site in dist/ (what Netlify publishes)
```

## Add a case study (the main thing you'll do)

1. Copy any file in `src/content/work/` and rename it, e.g. `asin-character-limits.md`.
2. Edit the frontmatter at the top (between the `---` lines):
   - `title`, `summary`, `theme`, `date`
   - `metrics`: punchy numbers shown as small tags
   - `labUrl` (optional): if the piece is published on The Lab, set this to its URL. The tile then
     links straight out to the Lab and **no on-site page is generated** — this avoids duplicate
     content and keeps the two from drifting. Leave it unset for work that should have a full
     on-site page (e.g. confidential or visual work that isn't on the Lab).
   - `draft: true` hides it from listings **and** builds no page at all; `draft: false` publishes.
3. Write the body in Markdown, following the shape: problem → how I framed it → what I tried →
   the result → what you can take away.
4. Save. If connected to Netlify, the site redeploys itself.

**Tile titles are recruiter-facing.** Unlike a Lab headline (which sells curiosity), a tile title
should lead with capability and outcome — e.g. "Aligning quality judgement in a week: 20% to 76%".
See the Lab content guide (Section 7) in the parent workspace for the full principle.

## Add an interactive / SCORM demo

1. In your authoring tool, publish to **HTML5 / Web output** (not a SCORM zip).
2. Drop the published folder into `public/demos/`, e.g. `public/demos/mqm-severity/`.
3. It is now served at `/demos/mqm-severity/index.html`.
4. Add it to the `demos` list in `src/pages/demos.astro` to show it on the Demos page.

(For demos that need genuine SCORM tracking, host on SCORM Cloud and embed the share link instead.)

## Design

The site uses the **Swiss International Style** design system — IBM Plex Sans, a stone palette,
opacity-based hierarchy, one accent, rectilinear forms, generous whitespace, and automatic dark
mode. It's applied as **vanilla CSS** in `src/styles/global.css` (tokens as CSS custom properties);
fonts and colour-scheme meta live in `src/layouts/Base.astro`.

- **Accent:** Cobalt `#003B8E`. To change it, edit the `--accent` RGB triplet at the top of
  `global.css` (alternatives are listed in the comment there). One accent only — use opacity, not
  new hues, for hierarchy.
- The full design system and usage notes live in the parent workspace at
  `.kiro/skills/swiss-design/`; this site just consumes it.

## Structure

```
src/
  layouts/Base.astro        shared page shell (header, footer, fonts, meta)
  pages/index.astro         home / CV hub
  pages/work/               case-study listing + individual pages
  pages/demos.astro         interactive samples
  content/work/*.md         your case studies (edit these)
  content.config.ts         defines the case-study fields
  styles/global.css         all styling, in one file (Swiss design system — see Design above)
public/                     static files served as-is (favicon, demos)
```
