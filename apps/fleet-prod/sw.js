const CACHE='fleet-prod-shell-20260817-1';
const INDEX='./index.html';
const SCOPE_PATH=new URL(self.registration.scope).pathname;
async function cacheUrl(cache,url){try{const r=await fetch(url,{cache:'reload'});if(r.ok){await cache.put(url,r.clone());return r}}catch{}return null}
function moduleRefs(text){return [...new Set([...text.matchAll(/['\"](\.\/[^'\"]+)['\"]/g)].map(m=>m[1]).filter(x=>/\.(?:js|css)(?:\?|$)/.test(x)))]}
async function cacheModuleTree(cache,url,seen=new Set()){
  if(seen.has(url))return;seen.add(url);
  const res=await cacheUrl(cache,url);if(!res||!url.match(/\.js(?:\?|$)/))return;
  const text=await res.text();
  for(const child of moduleRefs(text))await cacheModuleTree(cache,child,seen);
}
async function cacheShell(){
  const cache=await caches.open(CACHE);
  const res=await fetch(INDEX,{cache:'reload'});if(!res.ok)throw new Error(`index ${res.status}`);
  const html=await res.clone().text();await cache.put(INDEX,res.clone());await cache.put('./',res.clone());
  const refs=[...html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)].map(m=>m[1]);
  const direct=[...new Set(refs.filter(x=>!x.startsWith('./sw.js')))];
  for(const url of direct){if(/\.js(?:\?|$)/.test(url))await cacheModuleTree(cache,url);else await cacheUrl(cache,url)}
}
self.addEventListener('install',event=>{event.waitUntil(cacheShell().then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>(k.startsWith('fleet-prod-shell-')||k.startsWith('fleet-mvp-shell-'))&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim()})())});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==self.location.origin||!url.pathname.startsWith(SCOPE_PATH))return;
  if(req.mode==='navigate'){
    event.respondWith((async()=>{try{const net=await fetch(req);if(net.ok){const c=await caches.open(CACHE);await c.put(INDEX,net.clone());await c.put('./',net.clone())}return net}catch{return(await caches.match(INDEX))||(await caches.match('./'))||Response.error()}})());return;
  }
  event.respondWith((async()=>{
    const relative=url.pathname.slice(SCOPE_PATH.length);const key=`./${relative}${url.search}`;
    const cached=await caches.match(key)||await caches.match(req);
    if(cached){event.waitUntil(fetch(req).then(async net=>{if(net.ok){const c=await caches.open(CACHE);await c.put(key,net.clone())}}).catch(()=>{}));return cached}
    try{const net=await fetch(req);if(net.ok){const c=await caches.open(CACHE);await c.put(key,net.clone())}return net}catch{return Response.error()}
  })());
});
