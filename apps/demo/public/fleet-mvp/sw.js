const CACHE='fleet-mvp-shell-20260815-2';
const INDEX='./index.html';

async function cacheShell(){
  const cache=await caches.open(CACHE);
  const res=await fetch(INDEX,{cache:'reload'});
  if(!res.ok)throw new Error(`index ${res.status}`);
  const html=await res.clone().text();
  await cache.put(INDEX,res.clone());
  await cache.put('./',res.clone());
  const refs=[...html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^" ]*)?"/g)].map(m=>`./${m[1]}`);
  const unique=[...new Set(refs.filter(x=>!x.endsWith('sw.js')))];
  await Promise.all(unique.map(async url=>{
    try{const r=await fetch(url,{cache:'reload'});if(r.ok)await cache.put(url,r.clone())}catch{}
  }));
}

self.addEventListener('install',event=>{
  event.waitUntil(cacheShell().then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('fleet-mvp-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(!url.pathname.includes('/fleet-mvp/'))return;

  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const net=await fetch(req);
        if(net.ok){const c=await caches.open(CACHE);await c.put(INDEX,net.clone());await c.put('./',net.clone())}
        return net;
      }catch{
        return (await caches.match(INDEX))||(await caches.match('./'))||Response.error();
      }
    })());
    return;
  }

  event.respondWith((async()=>{
    const key=`./${url.pathname.split('/fleet-mvp/')[1]}`;
    const cached=await caches.match(key)||await caches.match(req);
    if(cached){
      event.waitUntil(fetch(req).then(async net=>{if(net.ok){const c=await caches.open(CACHE);await c.put(key,net.clone())}}).catch(()=>{}));
      return cached;
    }
    try{
      const net=await fetch(req);
      if(net.ok){const c=await caches.open(CACHE);await c.put(key,net.clone())}
      return net;
    }catch{return Response.error()}
  })());
});
