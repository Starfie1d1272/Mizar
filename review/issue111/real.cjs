const { chromium } = require(process.env.ISSUE111_PLAYWRIGHT);
const fs=require('fs');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.ISSUE111_CHROMIUM,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
 fs.mkdirSync(`${process.env.ISSUE111_OUTPUT}/real`,{recursive:true});
 const result=[];
 for(const fixture of ['1930','2000']){
  const source=JSON.parse(fs.readFileSync(`${process.env.ISSUE111_ROOT}/apps/web/__issue111_review-${fixture}.json`));
  for(const card of source.pages.filter(p=>p.kind!=='match')){
   await page.goto(`http://127.0.0.1:${process.env.ISSUE111_WEB_PORT}/__issue111_review.html?fixture=${fixture}&card=${card.id}`,{waitUntil:'domcontentloaded'});
   await page.locator('.stats-insert').waitFor({timeout:15000});
   await page.evaluate(async()=>{await document.fonts.ready; await Promise.race([Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,4000))]);});
   const counts=await page.evaluate(()=>({images:[...document.images].length,loaded:[...document.images].filter(i=>i.complete&&i.naturalWidth).length,bodyWidth:document.documentElement.scrollWidth}));
   await page.screenshot({path:`${process.env.ISSUE111_OUTPUT}/real/${fixture}-${card.id}.png`,animations:'disabled',timeout:15000});
   result.push({fixture,id:card.id,kind:card.kind,...counts});
  }
 }
 fs.writeFileSync(`${process.env.ISSUE111_OUTPUT}/real/results.json`,JSON.stringify({result,errors},null,2)); console.log(JSON.stringify({count:result.length,errors,unloaded:result.filter(x=>x.loaded<x.images),overflow:result.filter(x=>x.bodyWidth>1920)}));
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
