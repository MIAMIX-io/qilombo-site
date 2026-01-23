import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import https from 'https';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// 1. CONFIGURATION
const TARGET_WEBSITE = 'qilombo.tech'; 

async function syncPages() {
  console.log(`🔄 Starting Sync for: ${TARGET_WEBSITE}...`);
  
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
      console.log("No pages found. Check your Notion properties.");
  }

  for (const page of response.results) {
    const props = page.properties;
    const title = props['Page Title']?.title[0]?.plain_text || 'untitled';
    const slug = props['URL Slug']?.rich_text[0]?.plain_text || slugify(title);
    
    // Create folder for post images
    const imageDir = path.join('images', 'posts', slug);
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // --- HANDLE COVER IMAGE ---
    let coverImage = '';
    if (props['Cover Image'] && props['Cover Image'].files.length > 0) {
        const fileObj = props['Cover Image'].files[0];
        const imageUrl = fileObj.file?.url || fileObj.external?.url;
        if (imageUrl) {
            const ext = getExtension(imageUrl);
            const filename = `cover${ext}`;
            await downloadImage(imageUrl, path.join(imageDir, filename));
            coverImage = `/images/posts/${slug}/${filename}`;
        }
    }

    // --- FETCH BLOCKS & CONTENT ---
    const blocks = await notion.blocks.children.list({
      block_id: page.id,
      page_size: 100
    });
    
    const markdown = await convertBlocksToMarkdown(blocks.results, slug, imageDir);
    const frontmatter = generateFrontmatter(props, coverImage);
    
    // Write to '_content'
    const filepath = path.join('_content', `${slug}.md`);
    
    if (!fs.existsSync(path.dirname(filepath))) {
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
    }
    fs.writeFileSync(filepath, `${frontmatter}\n\n${markdown}`);
    
    console.log(`✓ Synced "${title}"`);
  }
}

// --- HELPER FUNCTIONS ---

function downloadImage(url, filepath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => {}); 
            reject(err.message);
        });
    });
}

function getExtension(url) {
    const cleanUrl = url.split('?')[0];
    const ext = path.extname(cleanUrl);
    return ext || '.jpg';
}

function generateFrontmatter(props, coverImage) {
  const meta = {
    layout: 'post',
    title: props['Page Title']?.title[0]?.plain_text,
    description: props['Meta Description']?.rich_text[0]?.plain_text,
    date: props['Publish Date']?.date?.start,
    tags: props['Tags']?.multi_select.map(t => t.name),
    image: coverImage,
    author: props['Author']?.rich_text[0]?.plain_text, // Updated to Text
    excerpt: props['Excerpt']?.rich_text[0]?.plain_text
  };
  
  return '---\n' + Object.entries(meta)
    .filter(([k, v]) => v)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n') + '\n---';
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

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
      case 'image':
        const imgObj = block.image;
        const imgUrl = imgObj.file?.url || imgObj.external?.url;
        const caption = imgObj.caption.length ? imgObj.caption[0].plain_text : "Image";
        if (imgUrl) {
            const ext = getExtension(imgUrl);
            const filename = `${block.id}${ext}`;
            const savePath = path.join(imageDir, filename);
            const publicPath = `/images/posts/${slug}/${filename}`;
            try {
                await downloadImage(imgUrl, savePath);
                output.push(`![${caption}](${publicPath})`);
            } catch (e) {
                console.error(`Failed to download image: ${e}`);
            }
        }
        break;
      case 'video':
        const vidUrl = block.video?.external?.url || block.video?.file?.url;
        if (vidUrl && vidUrl.includes('youtube.com')) {
             const videoId = vidUrl.split('v=')[1]?.split('&')[0];
             if (videoId) {
                 output.push(`<iframe width="100%" height="400" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>`);
             }
        }
        break;
    }
  }
  return output.join('\n\n');
}

syncPages().catch(console.error);
