const UXD_VERSION='2026.08.15-dialog2';
const uxdBypass=new WeakSet();
let uxdResolve=null,uxdLastFocus=null;

function uxdEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function uxdClose(value=null){const root=document.querySelector('.uxd-backdrop');if(root)root.remove();const resolve=uxdResolve;uxdResolve=null;document.body.classList.remove('uxd-open');if(uxdLastFocus?.isConnected)uxdLastFocus.focus();uxdLastFocus=null;resolve?.(value)}
function uxdDialog({title,body='',confirmLabel='Продолжить',danger=false,fields=[]}){
  if(uxdResolve)uxdClose(null);
  uxdLastFocus=document.activeElement;
  return new Promise(resolve=>{
    uxdResolve=resolve;
    const root=document.createElement('div');root.className='uxd-backdrop';
    root.innerHTML=`<div class="uxd-dialog" role="dialog" aria-modal="true" aria-labelledby="uxdTitle"><div class="uxd-head"><div><div class="uxd-kicker">Подтверждение</div><h2 id="uxdTitle">${uxdEsc(title)}</h2></div><button type="button" class="uxd-x" data-uxd-cancel aria-label="Закрыть">×</button></div>${body?`<p class="uxd-body">${uxdEsc(body)}</p>`:''}${fields.length?`<div class="uxd-fields">${fields.map(f=>f.type==='select'?`<label><span>${uxdEsc(f.label)}</span><select name="${uxdEsc(f.name)}">${(f.options||[]).map(o=>`<option value="${uxdEsc(o.value)}" ${o.value===f.value?'selected':''}>${uxdEsc(o.label)}</option>`).join('')}</select></label>`:`<label><span>${uxdEsc(f.label)}</span><textarea name="${uxdEsc(f.name)}" rows="3" placeholder="${uxdEsc(f.placeholder||'')}">${uxdEsc(f.value||'')}</textarea></label>`).join('')}</div>`:''}<div class="uxd-actions"><button type="button" class="ghost-btn" data-uxd-cancel>Отмена</button><button type="button" class="${danger?'danger-btn':'primary-btn'}" data-uxd-confirm>${uxdEsc(confirmLabel)}</button></div></div>`;
    document.body.appendChild(root);document.body.classList.add('uxd-open');
    root.querySelector('[data-uxd-cancel]')?.focus();
    root.addEventListener('click',e=>{
      if(e.target===root||e.target.closest('[data-uxd-cancel]'))return uxdClose(null);
      if(e.target.closest('[data-uxd-confirm]')){const values={};root.querySelectorAll('select,textarea,input').forEach(el=>values[el.name]=el.value);uxdClose(fields.length?values:true)}
    });
    root.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();uxdClose(null)}if(e.key==='Tab'){const fs=[...root.querySelectorAll('button,select,textarea,input')].filter(x=>!x.disabled);if(!fs.length)return;const first=fs[0],last=fs[fs.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
  })
}
window.fleetUxDialog=uxdDialog;
function uxdReplayClick(el,{confirm=true,prompts=[]}={}){const oldConfirm=window.confirm,oldPrompt=window.prompt;let i=0;window.confirm=()=>confirm;window.prompt=()=>prompts[i++]??null;try{uxdBypass.add(el);el.click()}finally{window.confirm=oldConfirm;window.prompt=oldPrompt}}
function uxdReplaySubmit(form){const oldConfirm=window.confirm;window.confirm=()=>true;try{form.dataset.uxdBypass='1';form.requestSubmit()}finally{window.confirm=oldConfirm}}
function uxdDirtyForm(){return [...document.querySelectorAll('.main form[data-uxd-dirty="1"]')].find(f=>f.isConnected)||null}
function uxdClearDirty(form){if(form)delete form.dataset.uxdDirty}

async function uxdInterceptClick(e){const el=e.target.closest('[data-action]');if(!el)return;if(uxdBypass.has(el)){uxdBypass.delete(el);return}const a=el.dataset.action;
  if(['back','main-nav','logout','refresh'].includes(a)){
    const dirty=uxdDirtyForm();
    if(dirty){e.preventDefault();e.stopImmediatePropagation();const ok=await uxdDialog({title:'Изменения не сохранены',body:'Вы уже начали заполнять форму. Если уйти сейчас, введённые данные будут потеряны.',confirmLabel:'Уйти без сохранения',danger:true});if(ok){uxdClearDirty(dirty);uxdReplayClick(el)}return}
  }
  if(a==='approve-waybill'){
    e.preventDefault();e.stopImmediatePropagation();const ok=await uxdDialog({title:'Утвердить путевой лист?',body:'Конечные пробег и остаток топлива станут подтверждённым состоянием машины.',confirmLabel:'Утвердить'});if(ok)uxdReplayClick(el);return;
  }
  if(a==='set-incident-condition'){
    e.preventDefault();e.stopImmediatePropagation();const label=(el.textContent||'').trim();const ok=await uxdDialog({title:'Зафиксировать состояние техники?',body:`Будет записано: «${label}». Решение попадёт в историю происшествия.`,confirmLabel:'Зафиксировать'});if(ok)uxdReplayClick(el);return;
  }
  if(a==='repair-action'){
    e.preventDefault();e.stopImmediatePropagation();const label=(el.textContent||'').trim();const ok=await uxdDialog({title:'Изменить этап ремонта?',body:`Действие: «${label}». Изменение будет сохранено в истории ремонта.`,confirmLabel:'Продолжить'});if(ok)uxdReplayClick(el);return;
  }
  if(a==='return-correction'){
    e.preventDefault();e.stopImmediatePropagation();const v=await uxdDialog({title:'Вернуть путевой лист на исправление',body:'Водитель увидит понятное замечание и сможет отправить данные повторно.',confirmLabel:'Вернуть водителю',fields:[{type:'select',name:'type',label:'Что проверить',value:'other',options:[{value:'closing_state',label:'Конечные показания'},{value:'route',label:'Маршрут'},{value:'refuel',label:'Заправки'},{value:'other',label:'Другое'}]},{type:'textarea',name:'message',label:'Комментарий водителю',value:'Проверьте данные и отправьте повторно.',placeholder:'Что именно нужно проверить'}]});if(v&&v.message?.trim())uxdReplayClick(el,{prompts:[v.type,v.message.trim()]});return;
  }
}
document.addEventListener('click',uxdInterceptClick,true);

document.addEventListener('input',e=>{const form=e.target?.closest?.('.main form');if(form&&e.isTrusted)form.dataset.uxdDirty='1'},true);
document.addEventListener('change',e=>{const form=e.target?.closest?.('.main form');if(form&&e.isTrusted)form.dataset.uxdDirty='1'},true);
window.addEventListener('beforeunload',e=>{if(!uxdDirtyForm())return;e.preventDefault();e.returnValue=''});

document.addEventListener('submit',async e=>{const form=e.target;if(!(form instanceof HTMLFormElement)||form.id!=='maintenanceCompleteForm')return;if(form.dataset.uxdBypass==='1'){delete form.dataset.uxdBypass;return}e.preventDefault();e.stopImmediatePropagation();const ok=await uxdDialog({title:'Записать выполненное ТО?',body:'Запись попадёт в историю обслуживания и обновит расчёт следующего ТО.',confirmLabel:'Записать ТО'});if(ok)uxdReplaySubmit(form)},true);
