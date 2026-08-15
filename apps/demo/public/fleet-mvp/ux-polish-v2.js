const UXP_VERSION='2026.08.15-ux-polish-2';

function uxText(el){return (el?.textContent||'').replace(/\s+/g,' ').trim()}
function uxEsc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

function uxScreen(main){
  const title=uxText(main.querySelector('.page-title'));
  if(title==='Моя машина')return 'driver-work';
  if(main.querySelector('#driverActionForm'))return 'driver-action';
  if(main.querySelector('#issueForm'))return 'issue-waybill';
  if(main.querySelector('#vehicleCreateForm'))return 'create-vehicle';
  if(main.querySelector('#driverCreateForm'))return 'create-driver';
  if(main.querySelector('#assignmentForm'))return 'assignment';
  if(main.querySelector('#incidentCreateForm'))return 'incident-create';
  if(main.querySelector('#repairAssessmentForm'))return 'repair-assessment';
  if(main.querySelector('#maintenanceCompleteForm'))return 'maintenance-complete';
  if(main.querySelector('#evidenceForm'))return 'evidence';
  if(main.querySelector('[data-ec-action="edit-vehicle"]'))return 'vehicle';
  if(main.querySelector('[data-action="attention"]')&&main.querySelector('[data-action="issue-waybill"]'))return 'home';
  if(title==='Техника')return 'fleet';
  if(title==='ТО и ремонт')return 'service';
  if(title==='Печать')return 'print';
  if(title.startsWith('ПЛ '))return 'waybill';
  return 'generic';
}

function uxToneMetrics(main){
  main.querySelectorAll('.metric').forEach(m=>{
    const label=uxText(m.querySelector('.metric-label')||m.querySelector('.card-sub')).toLowerCase();
    m.classList.remove('ux-tone-success','ux-tone-warning','ux-tone-danger','ux-tone-info');
    if(/в эксплуатации|в работе|готов/.test(label))m.classList.add('ux-tone-success');
    else if(/ремонт|ждут проверки|исправлен|скоро то|новых неисправ/.test(label))m.classList.add('ux-tone-warning');
    else if(/недоступ|критич|просроч/.test(label))m.classList.add('ux-tone-danger');
    else if(/всего|получено|маршрут|пробег/.test(label))m.classList.add('ux-tone-info');
  });
}

function uxClickableA11y(main){
  main.querySelectorAll('.clickable[data-action]').forEach(el=>{
    if(!el.hasAttribute('tabindex'))el.tabIndex=0;
    if(!el.hasAttribute('role'))el.setAttribute('role','button');
    if(!el.hasAttribute('aria-label')){
      const label=uxText(el.querySelector('.list-title,.card-title,.alert-title'))||'Открыть';
      el.setAttribute('aria-label',label);
    }
  });
  document.querySelectorAll('.nav-btn').forEach(n=>{
    if(n.classList.contains('active'))n.setAttribute('aria-current','page');
    else n.removeAttribute('aria-current');
  });
}

function uxHome(main){
  const attention=main.querySelector('[data-action="attention"]')?.closest('.attention-grid');
  const section=attention?.closest('section');
  const first=attention?.querySelector('[data-action="attention"]');
  const head=main.querySelector('.page-head');
  if(!head||main.querySelector('.ux-command'))return;
  const total=uxText(section?.querySelector('.section-title .badge'))||'0';
  const firstTitle=uxText(first?.querySelector('.card-title'));
  const band=document.createElement('div');
  band.className=`ux-command ${Number(total)>0?'has-work':'all-clear'}`;
  if(Number(total)>0){
    band.innerHTML=`<div class="ux-command-copy"><span class="ux-kicker">Сейчас главное</span><strong>${uxEsc(total)} ${Number(total)===1?'задача':'задач'} требуют решения</strong><small>${firstTitle?`Сначала: ${uxEsc(firstTitle)}`:'Откройте первую задачу и двигайтесь по очереди.'}</small></div><button type="button" class="primary-btn ux-command-btn" data-ux-first-attention>Начать разбор</button>`;
  }else{
    band.innerHTML='<div class="ux-command-copy"><span class="ux-kicker">Состояние</span><strong>Критичных задач нет</strong><small>Можно переходить к плановой работе.</small></div>';
  }
  head.insertAdjacentElement('afterend',band);
  attention?.querySelectorAll('.card.clickable').forEach(card=>{
    if(card.querySelector('.ux-card-open'))return;
    const mark=document.createElement('div');
    mark.className='ux-card-open';
    mark.innerHTML='<span>Открыть</span><span aria-hidden="true">›</span>';
    card.appendChild(mark);
  });
}

function uxForms(main){
  main.querySelectorAll('form').forEach(form=>{
    if(form.dataset.uxForm===UXP_VERSION)return;
    form.dataset.uxForm=UXP_VERSION;
    let hasRequired=false;
    form.querySelectorAll('.field').forEach(field=>{
      const control=field.querySelector('input,select,textarea');
      const label=field.querySelector('label');
      if(!control)return;
      if(control.required&&label){
        hasRequired=true;
        label.classList.add('ux-required');
      }
      if(control.tagName==='INPUT'){
        const name=(control.getAttribute('name')||'').toLowerCase();
        const type=(control.getAttribute('type')||'text').toLowerCase();
        if(type==='number')control.setAttribute('inputmode',/odometer|km/.test(name)?'numeric':'decimal');
        if(/phone/.test(name))control.setAttribute('inputmode','tel');
      }
    });
    if(hasRequired&&!form.querySelector('.ux-required-note')){
      const note=document.createElement('div');
      note.className='ux-required-note';
      note.textContent='* обязательные поля';
      form.prepend(note);
    }
    const submit=form.querySelector('button[type="submit"]');
    const row=submit?.closest('.action-row');
    if(row)row.classList.add('ux-sticky-submit');
  });
}

function uxDriverDock(main){
  if(main.querySelector('.ux-driver-dock'))return;
  const source=main.querySelector('.hero [data-action="driver-action"].primary-btn');
  if(!source||source.disabled)return;
  const dock=document.createElement('div');
  dock.className='ux-driver-dock';
  dock.innerHTML=`<button type="button" class="primary-btn ux-driver-dock-btn" data-action="driver-action" data-driver-action="${uxEsc(source.dataset.driverAction||'')}" data-waybill="${uxEsc(source.dataset.waybill||'')}">${uxEsc(uxText(source))}</button>`;
  main.appendChild(dock);
  source.classList.add('ux-source-primary');
}

function uxDetails(main){
  main.querySelectorAll('details > summary').forEach(s=>{
    if(!s.querySelector('.ux-summary-chevron')){
      const c=document.createElement('span');
      c.className='ux-summary-chevron';
      c.setAttribute('aria-hidden','true');
      c.textContent='⌄';
      s.appendChild(c);
    }
  });
}

function uxDecorate(){
  const main=document.querySelector('.main');
  if(!main)return;
  const screen=uxScreen(main);
  document.body.dataset.uxScreen=screen;
  main.dataset.uxPolish=UXP_VERSION;
  uxToneMetrics(main);
  uxClickableA11y(main);
  uxDetails(main);
  if(screen==='home')uxHome(main);
  if(screen==='driver-work')uxDriverDock(main);
  uxForms(main);
}

document.addEventListener('click',e=>{
  const first=e.target.closest('[data-ux-first-attention]');
  if(first){
    e.preventDefault();
    document.querySelector('.main [data-action="attention"]')?.click();
  }
},true);

document.addEventListener('keydown',e=>{
  if(!['Enter',' '].includes(e.key))return;
  const el=e.target.closest?.('.clickable[data-action][role="button"]');
  if(!el)return;
  e.preventDefault();
  el.click();
});

let uxPending=false;
function uxSchedule(){
  if(uxPending)return;
  uxPending=true;
  queueMicrotask(()=>{uxPending=false;uxDecorate()});
}
new MutationObserver(uxSchedule).observe(document.documentElement,{childList:true,subtree:true});
uxSchedule();
