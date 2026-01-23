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

function frontMatter(data) {
  return `---
title: "${data.title}"
slug: "${data.slug}"
category: "${data.category}"
published: ${data.published}
date: ${data.date}
---\n\n`;
}

// ----------------------------
// MAIN
// ----------------------------
async function sync() {
  console.log("🔄 Syncing content from Notion…");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
  }

  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Published",
      checkbox: {
        equals: true,
      },
    },
  });

  console.log(`📄 Found ${pages.results.length} published pages`);

  for (const page of pages.results) {
    const props = page.properties;

    const title =
      props.Name?.title?.[0]?.plain_text || "Untitled";

    const slug =
      props.Slug?.rich_text?.[0]?.plain_text ||
      slugify(title);

    const category =
      props.Category?.select?.name || "general";

    const published =
      props.Published?.checkbox ?? false;

    const date = page.created_time.split("T")[0];

    console.log(`➡ Writing: ${title}`);

    // Convert content to Markdown
    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdContent = n2m.toMarkdownString(mdBlocks);

    const output = frontMatter({
      title,
      slug,
      category,
      published,
      date,
    }) + mdContent;

    const filePath = path.join(
      OUTPUT_DIR,
      `${slug}.md`
    );

    fs.writeFileSync(filePath, output);
  }

  console.log("✅ Notion sync completed successfully");
}

sync().catch(
