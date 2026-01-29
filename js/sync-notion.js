import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import https from 'https';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// 1. CONFIGURATION
const TARGET_WEBSITE = 'qilombo.tech'; 
const OUTPUT_DIR = '_content';

async function syncPages() {
  console.log(`🔄 Starting Sync for: ${TARGET_WEBSITE}...`);

  if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      and: [
        { property: 'Sync to GitHub', checkbox: { equals: true } },
        { property: 'Status', status: { equals: 'Published' } },
        { property: 'Website', select: { equals: TARGET_WEBSITE } }
      ]
    }
  });

  if (response.results.length === 0) {
      console.log("ℹ️ No 'Published' pages found.");
  }

  for (const page of response.results) {
    const props = page.properties;
    const title = props['Page Title']?.title[0]?.plain_text || 'untitled';
    const slug = props['URL Slug']?.rich_text[0]?.plain_text || slugify(title);
    
    console.log(`Processing: ${title}...`);

    const imageDir = path.join('images', 'posts', slug);
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // --- 1. DOWNLOAD COVER IMAGE ---
    let coverImage = '';
    if (props['Cover Image'] && props['Cover Image'].files.length > 0) {
        const fileObj = props['Cover Image'].files[0];
        const imageUrl = fileObj.file?.url || fileObj.external?.url;
        if (imageUrl) {
            const ext = getExtension(imageUrl);
            const filename = `cover${ext}`;
            try {
                await downloadImage(imageUrl, path.join(imageDir, filename));
                coverImage = `/images/posts/${slug}/${filename}`;
            } catch (err) {
                console.error(`⚠️ Failed to download cover: ${err.message}`);
            }
        }
    }

    // --- 2. FETCH BLOCKS RECURSIVELY ---
    const blocks = await fetchChildrenRecursively(page.id);
    
    // --- 3. CONVERT TO MARKDOWN ---
    const markdown = await convertBlocksToMarkdown(blocks, slug, imageDir);
    const frontmatter = generateFrontmatter(props, coverImage);
    
    // --- 4. SAVE FILE ---
    const filepath = path.join(OUTPUT_DIR, `${slug}.md`);
    fs.writeFileSync(filepath, `${frontmatter}\n\n${markdown}`);
    
    console.log(`✓ Synced file: "${slug}.md"`);

    // --- 5. UPDATE STATUS TO LIVE ---
    try {
        await notion.pages.update({
            page_id: page.id,
            properties: { 'Status': { status: { name: 'Live' } } }
        });
        console.log(`✨ Updated Notion Status to "Live"`);
    } catch (error) {
        console.error(`⚠️ Failed to update Notion status: ${error.message}`);
    }
  }
}

// --- RECURSIVE FETCHER ---
async function fetchChildrenRecursively(blockId) {
    let children = [];
    let cursor = undefined;
    
    while (true) {
        const { results, next_cursor, has_more } = await notion.blocks.children.list({
            block_id: blockId,
            start_cursor: cursor,
        });
        
        for (const block of results) {
            if (block.has_children) {
                block.children = await fetchChildrenRecursively(block.id);
            }
            children.push(block);
        }
        if (!has_more) break;
        cursor = next_cursor;
    }
    return children;
}

// --- CONVERTER ---
async function convertBlocksToMarkdown(blocks, slug, imageDir) {
  const output = [];
  
  for (const block of blocks) {
    switch(block.type) {
      case 'paragraph':
        output.push(block.paragraph.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'heading_1':
        output.push('# ' + block.heading_1.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'heading_2':
        output.push('## ' + block.heading_2.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'heading_3':
        output.push('### ' + block.heading_3.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'bulleted_list_item':
        output.push('- ' + block.bulleted_list_item.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'numbered_list_item':
        output.push('1. ' + block.numbered_list_item.rich_text.map(t => t.plain_text).join(''));
        break;
      case 'quote':
        output.push(`> ${block.quote.rich_text.map(t => t.plain_text).join('')}`);
        break;
      case 'divider':
        output.push(`---`);
        break;

      // --- FIXED: COLUMNS WITH MARKDOWN SUPPORT ---
      case 'column_list':
        const cols = block.children ? await convertBlocksToMarkdown(block.children, slug, imageDir) : '';
        output.push(`<div class="notion-row">\n${cols}\n</div>`);
        break;

      case 'column':
        const colContent = block.children ? await convertBlocksToMarkdown(block.children, slug, imageDir) : '';
        // 1. Added 'markdown="1"' to force rendering
        // 2. Added extra newlines '\n\n' which are critical for parsing
        output.push(`<div class="notion-col" markdown="1">\n\n${colContent}\n\n</div>`);
        break;
      // ---------------------------------------------

      case 'callout':
        const icon = block.callout.icon?.emoji || '💡';
        const text = block.callout.rich_text.map(t => t.plain_text).join('');
        output.push(`> ${icon} **${text}**`);
        break;

      case 'toggle':
        const summary = block.toggle.rich_text.map(t => t.plain_text).join('') || 'Click to reveal';
        const inner = block.children ? await convertBlocksToMarkdown(block.children, slug, imageDir) : '';
        output.push(`<details><summary>${summary}</summary>\n\n${inner}\n\n</details>`);
        break;

      case 'image':
        const imgUrl = block.image.file?.url || block.image.external?.url;
        const caption = block.image.caption?.length ? block.image.caption[0].plain_text : "Image";
        if (imgUrl) {
            const filename = `${block.id}${getExtension(imgUrl)}`;
            try {
                await downloadImage(imgUrl, path.join(imageDir, filename));
                output.push(`![${caption}](/images/posts/${slug}/${filename})`);
            } catch (e) { console.error(`Error DL image: ${e}`); }
        }
        break;
    }
  }
  return output.join('\n\n');
}

// --- HELPERS ---
function downloadImage(url, filepath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) { reject(new Error(response.statusCode)); return; }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(filepath, () => {}); reject(err.message); });
    });
}

function getExtension(url) {
    return path.extname(url.split('?')[0]) || '.jpg';
}

function generateFrontmatter(props, coverImage) {
  let authorName = 'Qilombo';
  if (props['Author']) {
      if (props['Author'].type === 'people' && props['Author'].people.length > 0) authorName = props['Author'].people[0].name;
      else if (props['Author'].type === 'rich_text' && props['Author'].rich_text.length > 0) authorName = props['Author'].rich_text[0].plain_text;
  }

  const meta = {
    layout: 'post',
    title: props['Page Title']?.title[0]?.plain_text,
    description: props['Meta Description']?.rich_text[0]?.plain_text,
    date: props['Publish Date']?.date?.start || new Date().toISOString().split('T')[0],
    tags: props['Tags']?.multi_select ? props['Tags'].multi_select.map(t => t.name) : [],
    image: coverImage,
    author: authorName,
    excerpt: props['Excerpt']?.rich_text[0]?.plain_text
  };
  
  return '---\n' + Object.entries(meta).filter(([k, v]) => v).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---';
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

syncPages().catch(console.error);
