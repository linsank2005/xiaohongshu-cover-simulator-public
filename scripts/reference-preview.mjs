import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";

export const previewDirectory = "previews/generated-reference-library";

export function renderReferencePreview(manifest) {
  const data = JSON.stringify(manifest).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>100 张模拟参考封面 · 统一预览</title>
<style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#292524;background:#faf8f5}*{box-sizing:border-box}body{margin:0}header{padding:32px max(24px,5vw) 20px;background:#fff;border-bottom:1px solid #e7e1d9}h1{font-size:28px;margin:0 0 10px}p{line-height:1.7;color:#78716c;margin:6px 0}.summary{font-size:15px;color:#57534e}.toolbar{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}input,select{font:inherit;border:1px solid #d6d3d1;border-radius:9px;background:#fff;padding:10px 12px}input{min-width:240px;flex:1;max-width:480px}.grid{padding:24px max(24px,5vw);display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:22px}.card{overflow:hidden;border:1px solid #e7e1d9;border-radius:12px;background:#fff;box-shadow:0 3px 12px #29252406}.cover{padding:0;background:#eee9e3;width:100%;border:0;display:block;cursor:zoom-in;aspect-ratio:3/4}.cover img{height:100%;width:100%;object-fit:contain;display:block}.pending{height:100%;display:grid;place-content:center;color:#a8a29e;cursor:default}.info{padding:13px 14px 16px}.number{font-weight:700;font-size:14px}.tag{font-size:12px;color:#78716c;margin-left:7px}.title{font-size:13px;margin:8px 0;line-height:1.6}.meta{font-size:11px;color:#a8a29e}.empty{grid-column:1/-1;text-align:center;padding:40px}dialog{padding:0;max-width:95vw;max-height:95vh;border:0;border-radius:12px;background:#fff}dialog::backdrop{background:#000b}.dialog-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 18px}dialog button{border:1px solid #d6d3d1;background:#fff;border-radius:8px;font:inherit;padding:7px 12px;cursor:pointer}.large{display:block;max-width:90vw;max-height:79vh;object-fit:contain;margin:auto}.dialog-foot{display:flex;justify-content:space-between;padding:12px 18px;gap:12px}.dialog-caption{font-size:12px;color:#78716c;align-self:center}@media(max-width:600px){header{padding:22px 18px}h1{font-size:23px}.grid{padding:18px;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.info{padding:10px}.toolbar input{min-width:100%;}.dialog-caption{display:none}}
</style></head><body>
<header><h1>100 张模拟参考封面</h1><p>根据原封面逐张作为参考，由 imagegen 生成的模拟示例，并非真实发布的封面。每个编号对应一张原稿。</p><div id="summary" class="summary"></div><div class="toolbar"><input id="search" aria-label="搜索编号、类型或标题" placeholder="搜索编号、类型或标题"><select id="category" aria-label="筛选类别"><option value="">全部类别</option></select><select id="track" aria-label="筛选内容类型"><option value="">全部内容类型</option></select></div></header>
<main id="grid" class="grid"></main><dialog id="lightbox"><div class="dialog-head"><strong id="detailTitle"></strong><button id="close" aria-label="关闭放大预览">关闭</button></div><img id="large" class="large" alt=""><div class="dialog-foot"><button id="previous">上一张</button><span id="detailMeta" class="dialog-caption"></span><button id="next">下一张</button></div></dialog>
<script id="preview-data" type="application/json">${data}</script>
<script>
const manifest=JSON.parse(document.getElementById('preview-data').textContent);
const samples=manifest.samples, grid=document.getElementById('grid'), search=document.getElementById('search'), category=document.getElementById('category'), track=document.getElementById('track'), lightbox=document.getElementById('lightbox');
let visible=[], current=null;
for(const [control,key] of [[category,'category'],[track,'track']])for(const value of [...new Set(samples.map(s=>s[key]))]){const option=document.createElement('option');option.value=value;option.textContent=value;control.append(option)}
function show(sample){current=sample;document.getElementById('detailTitle').textContent=sample.referenceKey+' · '+sample.track;document.getElementById('large').src=sample.fileName;document.getElementById('large').alt=sample.title;document.getElementById('detailMeta').textContent=sample.width+' × '+sample.height+' · '+sample.title;if(!lightbox.open)lightbox.showModal()}
function step(direction){const ready=visible.filter(s=>s.completionStatus==='generated');if(!ready.length)return;const index=ready.indexOf(current);show(ready[(index+direction+ready.length)%ready.length])}
function render(){const query=search.value.trim().toLowerCase();visible=samples.filter(s=>(!category.value||s.category===category.value)&&(!track.value||s.track===track.value)&&(!query||[s.referenceKey,s.title,s.category,s.track].join(' ').toLowerCase().includes(query)));grid.replaceChildren();document.getElementById('summary').textContent='已生成 '+samples.filter(s=>s.completionStatus==='generated').length+' / '+samples.length+' 张 · 当前显示 '+visible.length+' 张 · 点击图片放大';if(!visible.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='没有找到对应的封面';grid.append(empty)}for(const sample of visible){const card=document.createElement('article');card.className='card';const button=document.createElement('button');button.className='cover';button.setAttribute('aria-label','放大 '+sample.referenceKey+' '+sample.track);if(sample.completionStatus==='generated'){const img=document.createElement('img');img.src=sample.fileName;img.alt=sample.title;img.loading='lazy';button.append(img);button.addEventListener('click',()=>show(sample))}else{const pending=document.createElement('span');pending.className='pending';pending.textContent='待生成';button.disabled=true;button.append(pending)}const info=document.createElement('div');info.className='info';const number=document.createElement('span');number.className='number';number.textContent=sample.referenceKey;const tag=document.createElement('span');tag.className='tag';tag.textContent=sample.track;const title=document.createElement('p');title.className='title';title.textContent=sample.title;const meta=document.createElement('div');meta.className='meta';meta.textContent=sample.category+' · '+(sample.completionStatus==='generated'?sample.width+' × '+sample.height:'待生成');info.append(number,tag,title,meta);card.append(button,info);grid.append(card)}}
search.addEventListener('input',render);category.addEventListener('change',render);track.addEventListener('change',render);document.getElementById('close').addEventListener('click',()=>lightbox.close());document.getElementById('previous').addEventListener('click',()=>step(-1));document.getElementById('next').addEventListener('click',()=>step(1));lightbox.addEventListener('click',event=>{if(event.target===lightbox)lightbox.close()});document.addEventListener('keydown',event=>{if(lightbox.open&&event.key==='ArrowLeft')step(-1);if(lightbox.open&&event.key==='ArrowRight')step(1)});render();
</script></body></html>\n`;
}

export function rebuildReferencePreview(root = process.cwd()) {
  const directory = path.join(root, previewDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(directory, "index.html"), renderReferencePreview(manifest));
  return manifest;
}

export async function recordGeneratedSample(referenceKey, sourcePath, root = process.cwd()) {
  const directory = path.join(root, previewDirectory);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sample = manifest.samples.find((entry) => entry.referenceKey === referenceKey);
  if (!sample || !/^sim-\d{3}\.png$/.test(sample.fileName)) throw new Error("Unknown sample");
  if (sample.completionStatus === "generated") throw new Error("Sample already recorded");
  const bytes = fs.readFileSync(sourcePath);
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png") throw new Error("Expected imagegen PNG output");
  await sharp(bytes).raw().toBuffer();
  fs.copyFileSync(sourcePath, path.join(directory, sample.fileName));
  Object.assign(sample, {completionStatus: "generated", width: metadata.width, height: metadata.height, sha256: createHash("sha256").update(bytes).digest("hex")});
  manifest.completedCount = manifest.samples.filter((entry) => entry.completionStatus === "generated").length;
  manifest.status = manifest.completedCount === manifest.samples.length ? "pending-user-review" : "generating";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  rebuildReferencePreview(root);
  return {referenceKey, completedCount: manifest.completedCount, width: metadata.width, height: metadata.height};
}

export async function reviseGeneratedSample(referenceKey, sourcePath, prompt, root = process.cwd()) {
  const directory = path.join(root, previewDirectory);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sample = manifest.samples.find((entry) => entry.referenceKey === referenceKey);
  if (!sample || !/^sim-\d{3}\.png$/.test(sample.fileName) || sample.completionStatus !== "generated") throw new Error("Unknown generated sample");
  if (!prompt || prompt.length < 20) throw new Error("Revision prompt is required");
  const destination = path.join(directory, sample.fileName);
  const existing = fs.readFileSync(destination);
  if (createHash("sha256").update(existing).digest("hex") !== sample.sha256) throw new Error("Existing image changed");
  const bytes = fs.readFileSync(sourcePath);
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png") throw new Error("Expected imagegen PNG output");
  await sharp(bytes).raw().toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (Math.abs((metadata.width / metadata.height) / (sample.width / sample.height) - 1) > 0.025) throw new Error("Revision changed aspect ratio");
  sample.revisions ??= [];
  sample.revisions.push({ tool: "builtin-imagegen", referencedImageCount: 1, prompt, priorSha256: sample.sha256, sha256, width: metadata.width, height: metadata.height });
  fs.copyFileSync(sourcePath, destination);
  Object.assign(sample, { width: metadata.width, height: metadata.height, sha256 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  rebuildReferencePreview(root);
  return { referenceKey, revisionCount: sample.revisions.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "record") console.log(JSON.stringify(await recordGeneratedSample(process.argv[3], process.argv[4])));
  else if (process.argv[2] === "revise") console.log(JSON.stringify(await reviseGeneratedSample(process.argv[3], process.argv[4], process.argv[5])));
  else if (process.argv[2] === "build") console.log(JSON.stringify({completedCount: rebuildReferencePreview().completedCount}));
  else throw new Error("Use record/revise <ref-id> <generated-png> [prompt] or build");
}
