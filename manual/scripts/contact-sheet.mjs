import { chromium } from 'playwright'; import { readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2], files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const per = Number(process.argv[3] || 12); const b = await chromium.launch();
for (let k = 0; k * per < files.length; k++) {
  const p = await b.newPage({ viewport: { width: 1800, height: 1000 } });
  const imgs = files.slice(k * per, k * per + per).map(f => `<figure style="margin:4px;width:210px;display:inline-block;vertical-align:top"><img src="data:image/png;base64,${readFileSync(dir + '/' + f).toString('base64')}" style="width:210px;border:1px solid #999"><figcaption style="font:12px Arial">${f}</figcaption></figure>`).join('');
  await p.setContent(`<body style="margin:0">${imgs}</body>`); await p.screenshot({ path: `/tmp/claude-0/shots/sheet-${k + 1}.png`, fullPage: true });
}
await b.close(); console.log(Math.ceil(files.length / per));
