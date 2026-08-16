/** Извлекает dataIssues ИЗ ФАЙЛА m/app.js (не копия) и гоняет на синтетике. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../m/app.js', import.meta.url),'utf8');
const i0 = src.indexOf('function dataIssues()');
if (i0 < 0) { console.error('dataIssues не найдена'); process.exit(1); }
// вырезаем до следующей top-level функции
let depth=0, i=i0, started=false;
for (; i<src.length; i++){ const c=src[i];
  if (c==='{'){ depth++; started=true; } else if (c==='}'){ depth--; if (started && depth===0){ i++; break; } } }
const body = src.slice(i0, i);
// хелперы из того же файла, которые dataIssues использует
const helperNames = ['safe'];
let helpers='';
for (const h of helperNames){
  const m = src.match(new RegExp('function '+h+'\\([^)]*\\)\\{[^\\n]*\\}'));
  if (m) helpers += m[0] + '\n';
}
const money = await import(new URL('../m/lib/money.js', import.meta.url).href);

const mk = (units) => {
  const b={ id:'b1', name:'B', floors:[{ id:'f1', name:'1', units }] };
  return { buildings:[b], user:{ email:'tony@al-en.com' }, settings:{},
    invoices:[], invoicesAvailable:true, invoiceBuckets:{} };
};
const run = (units) => {
  const snap = mk(units);
  const fn = new Function('snap','money','buildings', helpers + body + '\nreturn dataIssues();');
  return fn(snap, money, () => snap.buildings);
};

let bad=0;
const t=(name,units,expectRe)=>{
  const out=run(units);
  const hit=out.some(x=>expectRe.test(x.title));
  console.log((hit?'  ok ':'FAIL ')+name+(hit?'':' — найдено: '+JSON.stringify(out.map(x=>x.title))));
  if(!hit) bad++;
};
const tNone=(name,units)=>{
  const out=run(units);
  console.log((out.length===0?'  ok ':'FAIL ')+name+(out.length?' — лишнее: '+JSON.stringify(out.map(x=>x.title)):''));
  if(out.length) bad++;
};

// 1. забытая репетиция: занят, все конверты void, платежей нет
t('репетиция ловится', [{ id:'418', type:'office', status:'occupied', tenant:'Mark', email:'x@y.co', rent:1700,
  leaseEnvelopes:[{envelopeId:'e1',status:'voided'},{envelopeId:'e2',status:'voided'}], payments:{} }], /rehearsal/i);
// ...но подписанная лиза НЕ ловится
tNone('подписанная лиза не трогается', [{ id:'101', type:'office', status:'occupied', tenant:'Real', email:'r@y.co', rent:1000,
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:1000}} }]);
// 2. почта в имени
t('почта в имени ловится', [{ id:'320', type:'office', status:'occupied', tenant:'Dev2@gmail.com', email:'d@g.com', rent:800,
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:800}} }], /email|@/i);
// 3. rate разъехался
t('rate-дрейф ловится', [{ id:'317', type:'office', status:'occupied', tenant:'K P', email:'k@p.co',
  contractRent:1050, sqft:161, rate:0.75, rent:1050,
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:1050}} }], /rate/i);
tNone('верный rate не трогается', [{ id:'318', type:'office', status:'occupied', tenant:'K P', email:'k@p.co',
  contractRent:1050, sqft:161, rate:78.26, rent:1050,
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:1050}} }]);
// 4. дубль прямоугольника
t('дубль прямоугольника ловится', [
  { id:'2072', type:'office', status:'vacant', x:10,y:10,w:77,h:77 },
  { id:'NEW-1', type:'office', status:'vacant', x:10,y:10,w:77,h:77 }], /footprint|rect|duplicate|identical|same outline/i);
tNone('нулевые прямоугольники не сталкиваются', [
  { id:'a', type:'office', status:'vacant', x:0,y:0,w:0,h:0 },
  { id:'b', type:'office', status:'vacant', x:0,y:0,w:0,h:0 }]);
// голова мульти-лизы: contractRent = сумма группы — детектор rate молчит (ревью)
tNone('голова группы не флажится по rate', [{ id:'101', type:'office', status:'occupied', tenant:'NU', email:'n@u.edu',
  contractRent:13318, sqft:2210, rate:5.43, rent:13318, groupId:'g1', groupRole:'primary',
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:13318}} }]);
// плейсхолдерный номер NEW- у занятого юнита — «нужен настоящий номер»
t('NEW- с занятостью ловится', [{ id:'NEW-59447', type:'office', status:'occupied', tenant:'X', email:'x@y.co', rent:500,
  leaseEnvelopes:[{envelopeId:'e1',status:'completed'}], payments:{'2026-08':{status:'paid',amount:500}} }], /real suite number/i);
// ...но свободный NEW- без биллинга — законный черновик, молчим
tNone('свободный NEW- без биллинга не трогается', [{ id:'NEW-123', type:'office', status:'vacant' }]);
console.log(bad ? bad+' FAILURES' : 'все детекторы работают');
process.exit(bad?1:0);
