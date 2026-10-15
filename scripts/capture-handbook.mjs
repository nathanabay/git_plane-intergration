// Capture helpers for the handbook. Use with Playwright installed locally via
// npm i --no-save --package-lock=false playwright; npx playwright install chromium.
// Import from a local capture driver; pass an authenticated page, and use only
// the owner's approved demo project. Session files and credentials stay outside the repo.
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const imageDir=resolve(import.meta.dirname,'../docs/handbook/images');
export async function sanitize(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const replace=t=>t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g,'plane.example.com')
        .replace(/[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}/gi,'member@example.com')
        .replace(/Test Admin/g,'Alex Developer').replace(/E2E Member/g,'Sam Reviewer').replace(/e2e-member/g,'sam.reviewer')
        .replace(/GitSync Test/g,'Acme').replace(/jkkljnjknkjnkj/g,'Sample project').replace(/QLL Test/g,'Sample project');
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())) if(!['SCRIPT','STYLE'].includes(node.parentElement?.tagName)) node.nodeValue=replace(node.nodeValue);
      for(const e of document.querySelectorAll('input,textarea')) {if(e.type==='password')e.value='';else if(e.value)e.value=replace(e.value);}
      for(const e of document.querySelectorAll('[title],[aria-label]'))for(const a of ['title','aria-label'])if(e.hasAttribute(a))e.setAttribute(a,replace(e.getAttribute(a)));
      for(const a of document.querySelectorAll('a[href]'))if(/\/projects\/(?:c6c45f01|27ae891b|972d93a8)/.test(a.getAttribute('href')||''))a.style.visibility='hidden';
      for(const e of document.querySelectorAll('[data-cookie-consent],.js-cookie-consent-banner,[data-target="cookie-consent.banner"]'))e.remove();
    }).catch(()=>{});
  }
}
export async function capture(page, filename, caption, callouts=[], clip) {
  await page.evaluate(()=>document.querySelectorAll('[data-handbook-callout]').forEach(e=>e.remove()));
  await page.waitForTimeout(650);
  const boxes=[];
  for(const spec of callouts) boxes.push(spec.locator ? await spec.locator.boundingBox() : spec);
  await sanitize(page);
  for(let i=0;i<callouts.length;i++) {
    const spec=callouts[i];const box=boxes[i];
    if(!box)throw new Error(`Missing callout ${i+1} for ${filename}`);
    // Badge (27px) + arrow (17px) sit fully outside the target, pointing at its edge, so no label text is covered.
    // Left of the target when there is room, otherwise right of it with the arrow pointing back.
    const left=box.x-48>=4, x=spec.x??(left?box.x-48:Math.min(1409,box.x+box.width+21)), y=spec.y??Math.max(4,box.y+box.height/2-14);
    await page.evaluate(({i,x,y,left})=>{const e=document.createElement('div');e.dataset.handbookCallout='1';e.textContent=String(i+1);Object.assign(e.style,{position:'fixed',left:x+'px',top:y+'px',height:'27px',width:'27px',borderRadius:'50%',background:'#e34d26',color:'white',font:'bold 17px Arial',display:'grid',placeItems:'center',zIndex:'2147483647',border:'2px solid white',boxShadow:'0 1px 5px #0008',pointerEvents:'none'});const arrow=document.createElement('span');Object.assign(arrow.style,{position:'absolute',left:left?'27px':'-18px',top:'10px',width:'17px',height:'3px',background:'#e34d26'});e.append(arrow);document.body.append(e);},{i,x,y,left:spec.x===undefined?left:true});
  }
  mkdirSync(imageDir,{recursive:true});
  await page.screenshot({path:resolve(imageDir,filename),...(clip?{clip}:{})});
  appendFileSync('/tmp/handbook-captures.jsonl',JSON.stringify({filename,caption,source:new URL(page.url()).pathname,callouts:callouts.length,masked:'Network address, non-example emails, test display names and unrelated project names. Browser chrome excluded.'})+'\n');
  console.log('CAPTURED',filename,caption);
}
