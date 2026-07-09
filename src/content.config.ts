import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Each case study is a Markdown file in src/content/work/.
// Add a new one by copying an existing file and editing the frontmatter + body.
const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    theme: z.string(), // e.g. "Organisational change & AI adoption"
    date: z.coerce.date(),
    metrics: z.array(z.string()).default([]),
    // If set, the tile links straight out to the Lab article and no on-site
    // case-study page is generated. Leave unset for work that lives on-site.
    labUrl: z.string().url().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { work };
