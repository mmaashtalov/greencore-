const UXFG_VERSION='2026.08.16-form-guard3';
const trackedIds=new Set(['driverActionForm','issueForm','vehicleCreateForm','driverCreateForm','assignmentForm','incidentCreateForm','maintenanceCompleteForm','repairAssessmentForm']);
const state=new WeakMap();

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
      units.push({els:[...form.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)].filter(visibleControl)});
    }else units.push({els:[el]});
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
function clearBusy(form){
  const meta=state.get(form);
  if(!meta)return;
  meta.submitting=false;
  form.removeAttribute('aria-busy');
  if(meta.timer){clearTimeout(meta.timer);meta.timer=null}
  const btn=meta.submitButton;
  if(btn?.isConnected && btn.dataset.uxfgOriginal){
    btn.textContent=btn.dataset.uxfgOriginal;
    delete btn.dataset.uxfgOriginal;
  }
  meta.submitButton=null;
}
function setBusy(form){
  const meta=state.get(form);
  if(!meta||meta.submitting)return;
  meta.submitting=true;
  form.setAttribute('aria-busy','true');
  const btn=form.querySelector('button[type="submit"]');
  if(!btn)return;
  meta.submitButton=btn;
  if(!btn.dataset.uxfgOriginal)btn.dataset.uxfgOriginal=(btn.textContent||'Сохранить').trim();
  btn.textContent='Сохраняем…';
  btn.disabled=true;
  const observer=new MutationObserver(()=>{
    if(!btn.isConnected){observer.disconnect();return}
    if(!btn.disabled){observer.disconnect();clearBusy(form)}
  });
  observer.observe(btn,{attributes:true,attributeFilter:['disabled']});
  meta.timer=setTimeout(()=>{
    observer.disconnect();
    if(!form.isConnected||!meta.submitting)return;
    btn.disabled=false;
    clearBusy(form);
  },30000);
}
function decorate(form){
  if(!isTracked(form)||state.has(form))return;
  state.set(form,{submitting:false,submitButton:null,timer:null});
  form.dataset.uxfg=UXFG_VERSION;
  form.addEventListener('input',()=>renderProgress(form));
  form.addEventListener('change',()=>renderProgress(form));
  form.addEventListener('submit',()=>setBusy(form),true);
  renderProgress(form);
}
function scan(){document.querySelectorAll('form').forEach(decorate)}
let pending=false;
function schedule(){if(pending)return;pending=true;queueMicrotask(()=>{pending=false;scan()})}

new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('fleet:ui-ready',schedule);
document.addEventListener('invalid',e=>{
  const field=e.target;
  const form=field?.form;
  if(!isTracked(form))return;
  const host=field.closest('.field');
  host?.classList.add('uxfg-invalid');
  field.scrollIntoView?.({block:'center',behavior:'smooth'});
  setTimeout(()=>host?.classList.remove('uxfg-invalid'),1800);
},true);
schedule();
