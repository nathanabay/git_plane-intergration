#!/usr/bin/env node
// Build from the repository root:
// npm i --no-save --package-lock=false markdown-it playwright
// npx playwright install chromium
// node scripts/build-handbook.mjs
// Requires Node 24 and Chromium. Context7 confirmed page.pdf({outline:true})
// is supported since Playwright 1.42; this build also requests tagged PDF.
// Credentials and a running Plane are not needed: all assets are local.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';
const root=resolve(import.meta.dirname,'..');
const dir=join(root,'docs/handbook');
const md=new MarkdownIt({html:true,linkify:false,typographer:true});
// Keep administrator links useful outside the author's filesystem.
const repository='https://github.com/nathanabay/git_plane-intergration';
const originalLink=md.renderer.rules.link_open??((t,i,o,e,r)=>r.renderToken(t,i,o));
md.renderer.rules.link_open=(tokens,i,options,env,self)=>{const href=tokens[i].attrGet('href');if(href?.startsWith('../manual/'))tokens[i].attrSet('href',repository+'/blob/master/docs/manual/'+href.slice('../manual/'.length));return originalLink(tokens,i,options,env,self);};
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const files=readdirSync(dir).filter(f=>/^\d\d-.*\.md$/.test(f)).sort();
if(!files.length)throw new Error('No numbered handbook chapters');
const chapters=files.map((file,index)=>{const source=readFileSync(join(dir,file),'utf8');return {id:'chapter-'+(index+1),title:source.match(/^# (.+)$/m)?.[1]??file,html:md.render(source),file};});
const css=`
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e8edf3;color:#172b40;font-family:Arial,"DejaVu Sans",sans-serif;font-size:11pt;line-height:1.47}a{color:#126099;text-decoration:underline;text-underline-offset:2px}p{margin:0 0 3.8mm}h1,h2,h3,h4{color:#103652;line-height:1.2;break-after:avoid}h1{font-size:27pt;letter-spacing:-.7px;margin:0 0 9mm;padding:0 0 5mm;border-bottom:3px solid #e66a3c}h2{font-size:16.5pt;margin:7mm 0 4mm}h3{font-size:12.5pt;margin:5mm 0 3mm}h4{font-size:11pt;margin:4mm 0 2mm}strong{color:#103652}ul,ol{margin:0 0 4mm;padding-left:7mm}li{padding-left:1mm;margin:0 0 2mm}li>p{margin:0 0 2mm}code{font-family:"DejaVu Sans Mono",monospace;font-size:.89em;overflow-wrap:anywhere}p code,li code,td code{background:#eaf0f5;padding:.2mm 1mm;border-radius:2px}pre{margin:3mm 0 5mm;padding:4mm;background:#132e44;color:#f5f8fc;border-radius:3px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.42;font-size:10.5pt}pre code{font-size:1em}blockquote{margin:4mm 0 5mm;border-left:4px solid #2683a4;background:#edf7fa;padding:4mm 5mm;border-radius:0 4px 4px 0}blockquote p:last-child{margin-bottom:0}blockquote.warning{border-color:#cc6c21;background:#fff4e5}blockquote.example{border-color:#6a5aa2;background:#f2eff9}figure{margin:5mm 0 6mm;break-inside:avoid}figure img{display:block;width:100%;height:auto;max-height:112mm;object-fit:contain;object-position:left center;border:1px solid #d7e0e6;border-radius:3px}figcaption{font-size:9.5pt;line-height:1.4;color:#385267;margin-top:2.5mm}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:10.5pt;line-height:1.38;margin:3mm 0 5mm}th,td{border:1px solid #ccd7e0;padding:2.4mm 2.8mm;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:normal}th{background:#e5eef4;color:#143b57;font-weight:700}tr:nth-child(even) td{background:#f6f8fa}hr{border:0;border-top:1px solid #ccd7e0;margin:5mm 0}.sheet{width:210mm;height:297mm;background:white;position:relative;padding:22mm 17mm 18mm;break-after:page;margin:0 auto 8mm;overflow:hidden}.sheet:last-child{break-after:auto}.content{height:257mm;overflow:visible;display:flow-root}.running{position:absolute;left:17mm;right:17mm;top:10mm;font-size:8.5pt;line-height:1.25;color:#537085;letter-spacing:.3px;border-bottom:1px solid #d9e2e8;padding-bottom:2.5mm}.folio{position:absolute;bottom:8mm;left:17mm;right:17mm;border-top:1px solid #d9e2e8;padding-top:2.5mm;font-size:8.5pt;color:#537085;display:flex;justify-content:space-between}.cover{background:#12364e;color:white;padding:30mm 20mm}.cover .eyebrow{font-size:11pt;letter-spacing:2px;color:#81c7d9;text-transform:uppercase}.cover h1{font-size:42pt;color:white;line-height:1.12;border:0;margin:18mm 0 9mm;max-width:160mm}.cover h2{font-size:21pt;color:#b7dfea;line-height:1.35;font-weight:400}.cover p{color:#e6eff5;font-size:12pt;max-width:145mm}.cover .stripe{height:3mm;width:35mm;background:#e87848;margin:14mm 0}.cover .cover-bottom{position:absolute;bottom:22mm;font-size:10.5pt;color:#b7dfea}.toc h1{font-size:27pt}.toc-row{display:flex;gap:4mm;align-items:baseline;padding:2mm 0;border-bottom:1px dotted #c5d4df;font-size:10.5pt;line-height:1.3}.toc-row a{flex:1;text-decoration:none}.toc-row span{font-variant-numeric:tabular-nums;color:#456579}.cheat{font-size:10.5pt;line-height:1.3}.cheat h1{font-size:23pt;margin-bottom:5mm;padding-bottom:3mm}.cheat h2{font-size:12pt;margin:3mm 0 2mm}.cheat p,.cheat ol,.cheat ul{margin-bottom:2mm}.cheat ol{columns:2;column-gap:8mm}.cheat li{margin-bottom:.8mm;break-inside:avoid}.cheat pre{padding:2.5mm;margin:2mm 0;font-size:10.5pt}.cheat table{font-size:10.5pt;margin:2mm 0}.cheat td,.cheat th{padding:1.5mm 2mm}#source{display:none}@media print{html,body{background:white}.sheet{margin:0;box-shadow:none}}
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plane + GitHub Developer Handbook</title><base href="${new URL('file://'+dir+'/').href}"><style>${css}</style></head><body><section class="sheet cover"><div class="eyebrow">The developer's field guide · Community Edition 1.4.2</div><h1>Plane + GitHub</h1><h2>From your first work item<br>to your next merged pull request.</h2><div class="stripe"></div><p>A detailed, illustrated handbook for developers using Plane for tasks, GitHub for code, and git-sync to keep the two connected.</p><p>Meet the tools. Find your work. Link your code. Understand what happens next.</p><div class="cover-bottom">Website team · Fictional teaching examples<br>Verified against the running CE interface and this repository's code<br>15 October 2026</div></section><section class="sheet toc"><div class="running">Plane + GitHub · Developer Handbook</div><div class="content"><h1>Contents</h1><p>Each chapter link opens its starting page. Use your PDF viewer's bookmarks to jump to individual sections.</p><nav id="toc"></nav><blockquote><p><strong>Start here.</strong> Read chapters 1–3 on your first morning. Use chapters 4–7 while working in Plane. Chapters 8–12 connect that work to GitHub. Keep the last page beside your terminal.</p></blockquote></div></section><main id="pages"></main><div id="source">${chapters.map(c=>`<article data-id="${c.id}" data-title="${esc(c.title)}">${c.html}</article>`).join('')}</div></body></html>`;
mkdirSync(join(root,'.unlazy/handbook/build'),{recursive:true});
const htmlFile=join(root,'.unlazy/handbook/build/handbook.html');writeFileSync(htmlFile,html);
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1100,height:1200}});
 await page.goto(new URL('file://'+htmlFile).href);
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.complete?null:new Promise((ok,fail)=>{i.onload=ok;i.onerror=()=>fail(new Error('Image failed: '+i.src))})));});
 const result=await page.evaluate(()=>{
  const chapters=[...document.querySelectorAll('#source article')];const all=[];const chapterPages=[];const issues=[];
  function newSheet(title,cheat=false){const s=document.createElement('section');s.className='sheet'+(cheat?' cheat':'');const h=document.createElement('div');h.className='running';h.textContent=title;const c=document.createElement('div');c.className='content';s.append(h,c);document.querySelector('#pages').append(s);all.push(s);return c;}
  function fits(c){return c.scrollHeight<=c.clientHeight+1;}
  for(const article of chapters){
   const title=article.dataset.title;let content=newSheet(title,article.dataset.id==='chapter-16');chapterPages.push({id:article.dataset.id,title,page:all.length+2});
   for(const q of article.querySelectorAll('p'))if(q.children.length===1&&q.firstElementChild.tagName==='IMG'){const img=q.firstElementChild;const f=document.createElement('figure');const cap=document.createElement('figcaption');cap.textContent=img.alt;f.append(img,cap);q.replaceWith(f);}
   for(const q of article.querySelectorAll('blockquote')){const t=q.textContent.trim();if(/^Warning:/i.test(t))q.classList.add('warning');else if(/^Example:/i.test(t))q.classList.add('example');}
   const queue=[...article.children];let hIndex=0;
   while(queue.length){
    let el=queue.shift();
    if(el.classList.contains("pagebreak")){if(content.children.length)content=newSheet(title);continue;}
    if(/^H[1-6]$/.test(el.tagName)){el.id=el.tagName==='H1'?article.dataset.id:article.dataset.id+'-s'+(++hIndex);}
    content.append(el);
    const isHeading=/^H[1-6]$/.test(el.tagName);
    const room=content.clientHeight-(el.offsetTop-content.offsetTop+el.offsetHeight);
    if(fits(content)&&(!isHeading||!queue.length||room>=100))continue;
    el.remove();
    // Move a trailing heading with the first block of its section.
    // A table or image can require more than the minimum heading reserve.
    if(/^H[1-6]$/.test(content.lastElementChild?.tagName||'')){
      const tail=[];while(/^H[1-6]$/.test(content.lastElementChild?.tagName||'')){const h=content.lastElementChild;h.remove();tail.unshift(h);}
      if(content.children.length)content=newSheet(title,article.dataset.id==='chapter-16');
      content.append(...tail);
    }
    if(el.tagName==='TABLE'){
     const rows=[...el.querySelectorAll('tbody tr')];let part=el.cloneNode(false);if(el.querySelector('thead'))part.append(el.querySelector('thead').cloneNode(true));let tb=document.createElement('tbody');part.append(tb);content.append(part);let added=0;
     while(rows.length){let row=rows[0];tb.append(row);if(!fits(content)){row.remove();if(!added){part.remove();if(content.children.length){content=newSheet(title);content.append(part);tb.append(row);if(!fits(content))throw new Error('Table row taller than page: '+title);rows.shift();added++;continue;}throw new Error('Table row cannot fit: '+title);}content=newSheet(title);part=el.cloneNode(false);if(el.querySelector('thead'))part.append(el.querySelector('thead').cloneNode(true));tb=document.createElement('tbody');part.append(tb);content.append(part);added=0;}else{rows.shift();added++;}}
     continue;
    }
    if(['OL','UL'].includes(el.tagName)&&el.children.length>1){const children=[...el.children];const first=el.cloneNode(false);content.append(first);let count=0;while(children.length){const li=children[0];first.append(li);if(!fits(content)){li.remove();break;}children.shift();count++;}if(!count)first.remove();if(children.length){const rest=el.cloneNode(false);if(el.tagName==='OL')rest.start=Number(el.getAttribute('start')||1)+count;rest.append(...children);content=newSheet(title);queue.unshift(rest);}continue;}
    if(!content.children.length){content.append(el);issues.push('Oversize block: '+title+' '+el.tagName);continue;}
    content=newSheet(title,article.dataset.id==='chapter-16');content.append(el);
    if(!fits(content))issues.push('Oversize block: '+title+' '+el.tagName);
   }
  }
  const toc=document.querySelector('#toc');for(const c of chapterPages){const row=document.createElement('div');row.className='toc-row';const a=document.createElement('a');a.href='#'+c.id;a.textContent=c.title;const n=document.createElement('span');n.textContent=c.page;row.append(a,n);toc.append(row);}
  const sheets=[...document.querySelectorAll('.sheet')];sheets.forEach((s,i)=>{if(i===0)return;const f=document.createElement('div');f.className='folio';const l=document.createElement('span');l.textContent='Plane + GitHub · Developer Handbook';const r=document.createElement('span');r.textContent=(i+1)+' / '+sheets.length;f.append(l,r);s.append(f);});
  for(const s of sheets){const c=s.querySelector('.content');if(c&&c.scrollHeight>c.clientHeight+2)issues.push('Page overflow '+(sheets.indexOf(s)+1));if(c&&/^H[1-6]$/.test(c.lastElementChild?.tagName||''))issues.push('Orphan heading on page '+(sheets.indexOf(s)+1));if(c){const bounds=c.getBoundingClientRect();for(const el of c.querySelectorAll('img,pre,table')){const r=el.getBoundingClientRect();if(r.right>bounds.right+2||r.left<bounds.left-2)issues.push('Horizontal overflow on page '+(sheets.indexOf(s)+1));}}}
  if(document.querySelector('.toc .content').scrollHeight>document.querySelector('.toc .content').clientHeight)issues.push('Contents overflow');
  return {pages:sheets.length,chapterPages,issues};
 });
 writeFileSync(join(root,'.unlazy/handbook/build/handbook.paginated.html'),await page.content());
 if(result.issues.length)throw new Error(result.issues.join('\n'));
 await page.pdf({path:join(dir,'Plane-GitHub-Developer-Handbook.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true,outline:true,tagged:true});
 writeFileSync(join(root,'.unlazy/handbook/build/layout.json'),JSON.stringify(result,null,2));
 console.log(`Built handbook: ${result.pages} A4 pages; ${chapters.length} chapters; outline and linked contents enabled.`);
}finally{await browser.close();}
