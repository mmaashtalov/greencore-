const UXFG_VERSION='2026.08.16-form-guard1';
const trackedIds=new Set(['driverActionForm','issueForm','vehicleCreateForm','driverCreateForm','assignmentForm','incidentCreateForm','maintenanceCompleteForm','repairAssessmentForm']);
const state=new WeakMap();
let bypassNavigation=false;
let activeDialog=null;

function isTracked(form){
  return form instanceof HTMLFormElement && (trackedIds.has(form.id) || form.dataset.uxCritical==='1');
}
function visibleControl(el){
  return !el.disabled && el.type!=='hidden' && el.closest('[hidden]')===null;
}
function requiredUnits(form){
  const controls=[...form.elements].filter(el=>el instanceof HTMLElement && visibleControl(el) && el.matches?.('[required]'));
  const units=[];
  const seen=new Set();
  for(const el of controls){
    if(el instanceof HTMLInputElement && (el.type==='radio'||el.type==='checkbox') && el.name){
      const key=`${el.type}:${el.name}`;
      if(seen.has(key))continue;
      seen.add(key);
      units.push({key,els:[...form.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)].filter(visibleControl)});
    }else{
      units.push({key:el.name||el.id||String(units.length),els:[el]});
    }
  }
  return units;
}
function unitComplete(unit){
  const els=unit.els;
  if(!els.length)return true;
  const first=els[0];
  if(first instanceof HTMLInputElement && (first.type==='radio'||first.type==='checkbox'))return els.some(el=>el.checked);
  return els.every(el=>String(el.value??'').trim()!=='');
}
function completeness(form){
  const units=requiredUnits(form);
  return {total:units.length,done:units.filter(unitComplete).length};
}
function ensureProgress(form){
  const c=completeness(form);
  if(c.total<4)return null;
  let box=form.querySelector(':scope > .uxfg-progress');
  if(!box){
    box=document.createElement('div');
    box.className='uxfg-progress';
    box.setAttribute('role','status');
    box.setAttribute('aria-live','polite');
    box.innerHTML='<div class="uxfg-progress-head"><strong></strong><span></span></div><div class="uxfg-progress-track"><i></i></div>';
    form.prepend(box);
  }
  return box;
}
function renderProgress(form){
  const box=ensureProgress(form);
  if(!box)return;
  const c=completeness(form);
  const pct=c.total?Math.round(c.done/c.total*100):100;
  box.querySelector('strong').textContent=c.done===c.total?'Форма готова':'Заполнение формы';
  box.querySelector('span').textContent=`${c.done} из ${c.total} обязательных`;
  box.querySelector('i').style.width=`${pct}%`;
  box.classList.toggle('complete',c.done===c.total);
}
function markDirty(form){
  const meta=state.get(form);
  if(!meta||meta.submitting)return;
  meta.dirty=true;
  form.dataset.uxDirty='1';
  renderProgress(form);
}
function clearBusy(form){
  const meta=state.get(form);
  if(!meta)return;
  meta.submitting=false;
  form.removeAttribute('aria-busy');
  const btn=meta.submitButton;
  if(btn?.isConnected && btn.dataset.uxfgOriginal){
    btn.textContent=btn.dataset.uxfgOriginal;
    delete btn.dataset.uxfgOriginal;
  }
  meta.submitButton=null;
}
function setBusy(form){
  const meta=state.get(form);
  if(!meta)return;
  meta.submitting=true;
  form.setAttribute('aria-busy','true');
  const btn=form.querySelector('button[type="submit"]');
  if(btn){
    meta.submitButton=btn;
    if(!btn.dataset.uxfgOriginal)btn.dataset.uxfgOriginal=(btn.textContent||'Сохранить').trim();
    btn.textContent='Сохраняем…';
    const observer=new MutationObserver(()=>{
      if(!btn.isConnected){observer.disconnect();return}
      if(!btn.disabled){observer.disconnect();clearBusy(form)}
    });
    observer.observe(btn,{attributes:true,attributeFilter:['disabled']});
    setTimeout(()=>{observer.disconnect();if(form.isConnected&&!btn.disabled)clearBusy(form)},15000);
  }
}
function decorate(form){
  if(!isTracked(form)||state.has(form))return;
  state.set(form,{dirty:false,submitting:false,submitButton:null});
  form.dataset.uxfg=UXFG_VERSION;
  form.addEventListener('input',()=>markDirty(form));
  form.addEventListener('change',()=>markDirty(form));
  form.addEventListener('submit',()=>setBusy(form),true);
  renderProgress(form);
}
function currentDirtyForm(){
  return [...document.querySelectorAll('form')].find(form=>isTracked(form)&&state.get(form)?.dirty&&!state.get(form)?.submitting)||null;
}
function closeDialog(){
  activeDialog?.remove();
  activeDialog=null;
}
function showLeaveDialog(target){
  if(activeDialog)return;
  const overlay=document.createElement('div');
  overlay.className='uxfg-modal-backdrop';
  overlay.innerHTML='<div class="uxfg-modal" role="dialog" aria-modal="true" aria-labelledby="uxfgTitle"><div class="uxfg-modal-icon">!</div><div class="uxfg-modal-copy"><h2 id="uxfgTitle">Есть несохранённые данные</h2><p>Если уйти с этого экрана, введённые изменения будут потеряны.</p></div><div class="uxfg-modal-actions"><button type="button" class="ghost-btn" data-uxfg-leave>Уйти без сохранения</button><button type="button" class="primary-btn" data-uxfg-stay>Остаться</button></div></div>';
  document.body.appendChild(overlay);
  activeDialog=overlay;
  const stay=overlay.querySelector('[data-uxfg-stay]');
  const leave=overlay.querySelector('[data-uxfg-leave]');
  stay.focus();
  stay.addEventListener('click',closeDialog);
  leave.addEventListener('click',()=>{
    const form=currentDirtyForm();
    const meta=form&&state.get(form);
    if(meta){meta.dirty=false;form.removeAttribute('data-ux-dirty')}
    closeDialog();
    bypassNavigation=true;
    try{target.click()}finally{queueMicrotask(()=>{bypassNavigation=false})}
  });
  overlay.addEventListener('click',e=>{if(e.target===overlay)closeDialog()});
}
function navigationTarget(node){
  return node?.closest?.('[data-action="back"],[data-action="main-nav"],[data-action="logout"],.nav-btn,.back-btn');
}
function scan(){document.querySelectorAll('form').forEach(decorate)}
let pending=false;
function schedule(){if(pending)return;pending=true;queueMicrotask(()=>{pending=false;scan()})}

new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('fleet:ui-ready',schedule);
document.addEventListener('click',e=>{
  if(bypassNavigation)return;
  const target=navigationTarget(e.target);
  if(!target||!currentDirtyForm())return;
  e.preventDefault();
  e.stopImmediatePropagation();
  showLeaveDialog(target);
},true);
document.addEventListener('invalid',e=>{
  const field=e.target;
  const form=field?.form;
  if(!isTracked(form))return;
  field.closest('.field')?.classList.add('uxfg-invalid');
  setTimeout(()=>field.closest('.field')?.classList.remove('uxfg-invalid'),1800);
},true);
window.addEventListener('beforeunload',e=>{
  if(!currentDirtyForm())return;
  e.preventDefault();
  e.returnValue='';
});
document.addEventListener('keydown',e=>{
  if(!activeDialog)return;
  if(e.key==='Escape'){e.preventDefault();closeDialog()}
});
schedule();
