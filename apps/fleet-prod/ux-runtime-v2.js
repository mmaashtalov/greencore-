const UXR_VERSION='2026.08.15-runtime2';
const app=document.getElementById('app');
let lastSignature='';

function detectRole(){
  const brand=(document.querySelector('.brand-sub')?.textContent||'').toLowerCase();
  if(brand.includes('администратор'))return 'admin';
  if(brand.includes('водитель'))return 'driver';
  return document.querySelector('.login-wrap')?'guest':'';
}
function detectView(){
  const main=document.querySelector('.main');
  if(!main)return document.querySelector('.login-wrap')?'login':'';
  const title=(main.querySelector('.page-title')?.textContent||'').trim();
  if(main.querySelector('#driverActionForm'))return 'driverAction';
  if(main.querySelector('#issueForm'))return 'issueWaybill';
  if(main.querySelector('#vehicleCreateForm'))return 'createVehicle';
  if(main.querySelector('#driverCreateForm'))return 'createDriver';
  if(main.querySelector('#assignmentForm'))return 'assignment';
  if(title==='Моя машина')return 'driverWork';
  if(title==='История')return 'driverHistory';
  if(title==='Техника')return 'fleet';
  if(title==='Водители')return 'drivers';
  if(title==='ТО и ремонт')return 'service';
  if(title==='Печать')return 'print';
  if(title==='Путевые листы')return 'waybills';
  if(title==='Проверка путевых листов')return 'reviewQueue';
  if(title==='Проверка периода')return 'periodReview';
  if(/^ПЛ\s/.test(title))return 'waybill';
  if(main.querySelector('[data-action="attention"]')&&main.querySelector('[data-action="issue-waybill"]'))return 'home';
  if(main.querySelector('[data-ec-action="edit-vehicle"]'))return 'vehicle';
  return title||'screen';
}
function publish(){
  const role=detectRole(),view=detectView();
  document.body.dataset.role=role;
  document.body.dataset.view=view;
  const sig=`${role}|${view}|${document.querySelector('.main')?.childElementCount||0}`;
  if(sig===lastSignature)return;
  lastSignature=sig;
  window.dispatchEvent(new CustomEvent('fleet:ui-ready',{detail:{role,view,version:UXR_VERSION}}));
}
if(app){new MutationObserver(()=>queueMicrotask(publish)).observe(app,{childList:true});}
window.addEventListener('pageshow',publish);
queueMicrotask(publish);
