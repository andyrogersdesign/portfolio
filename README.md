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
   - `metrics`: the punchy numbers shown as pills
   - `draft: true` hides it; set `draft: false` to publish.
3. Write the body in Markdown, following the shape: problem → how I framed it → what I tried →
   the result → what you can take away.
4. Save. If connected to Netlify, the site redeploys itself.

## Add an interactive / SCORM demo

1. In your authoring tool, publish to **HTML5 / Web output** (not a SCORM zip).
2. Drop the published folder into `public/demos/`, e.g. `public/demos/mqm-severity/`.
3. It is now served at `/demos/mqm-severity/index.html`.
4. Add it to the `demos` list in `src/pages/demos.astro` to show it on the Demos page.

(For demos that need genuine SCORM tracking, host on SCORM Cloud and embed the share link instead.)

## Structure

```
src/
  layouts/Base.astro        shared page shell (header, footer)
  pages/index.astro         home / CV hub
  pages/work/               case-study listing + individual pages
  pages/demos.astro         interactive samples
  content/work/*.md         your case studies (edit these)
  content.config.ts         defines the case-study fields
  styles/global.css         all styling, in one file
public/                     static files served as-is (favicon, demos)
```
