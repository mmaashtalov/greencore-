const UXFR_VERSION='2026.08.18-fresh2';
function uxfrTime(d=new Date()){return new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit'}).format(d)}
function uxfrDecorate(){
  const main=document.querySelector('.main');
  const head=main?.querySelector('.page-head');
  const title=head?.querySelector('.page-title')?.textContent?.trim();
  if(!main||!head||!title||main.querySelector('form')||title==='Вход')return;
  let chip=head.querySelector('.uxfr-chip');
  if(!chip){
    chip=document.createElement('span');
    chip.className='uxfr-chip';
    const host=head.firstElementChild||head;
    host.appendChild(chip);
    main.dataset.uxfrAt=String(Date.now());
  }
  const at=Number(main.dataset.uxfrAt)||Date.now();
  const offline=!navigator.onLine;
  const next=offline?'Офлайн · показаны доступные данные':`Экран обновлён в ${uxfrTime(new Date(at))}`;
  chip.classList.toggle('offline',offline);
  // MutationObserver watches childList. Replacing identical textContent creates a
  // new child-list mutation and used to schedule this function forever.
  if(chip.textContent!==next)chip.textContent=next;
}
let uxfrPending=false;
function uxfrSchedule(){
  if(uxfrPending)return;
  uxfrPending=true;
  queueMicrotask(()=>{uxfrPending=false;uxfrDecorate()});
}
new MutationObserver(uxfrSchedule).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('online',uxfrDecorate);
window.addEventListener('offline',uxfrDecorate);
uxfrSchedule();
