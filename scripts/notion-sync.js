import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import path from "path";

// ----------------------------
// ENV
// ----------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.error("❌ Missing NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

// ----------------------------
// INIT
// ----------------------------
const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const OUTPUT_DIR = "_content";

// ----------------------------
// HELPERS
// ----------------------------
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function buildFrontMatter({ title, slug, category, published, date }) {
  return `---
title: "${title}"
slug: "${slug}"
category: "${category}"
published: ${published}
date: ${date}
---

`;
}

// ----------------------------
// MAIN
// ----------------------------
async function syncNotion() {
  console.log("🔄 Syncing content from Notion…");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Published",
      checkbox: { equals: true }
    }
  });

  console.log(`📄 Found ${response.results.length} published pages`);

  for (const page of response.results) {
    const props = page.properties;

    const title =
      props.Name?.title?.[0]?.plain_text ?? "Untitled";

    const slug =
      props.Slug?.rich_text?.[0]?.plain_text ??
      slugify(title);

    const category =
      props.Category?.select?.name ?? "general";

    const published =
      props.Published?.checkbox ?? false;

    const date =
      page.created_time.split("T")[0];

    console.log(`➡ Writing: ${title}`);

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const md = n2m.toMarkdownString(mdBlocks);

    const output =
      buildFrontMatter({
        title,
        slug,
        category,
        published,
        date
      }) + md;

    const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
    fs.writeFileSync(filePath, output);
  }

  console.log("✅ Notion sync completed successfully");
}

// ----------------------------
// RUN
// ----------------------------
syncNotion().catch((error) => {
  console.error("❌ Sync failed:", error);
  process.exit(1);
});
