const UXRW_VERSION='2026.08.15-recent1';
const UXRW_KEY='fleet_mvp_global_search_recents_v1';
function readRecent(){try{return JSON.parse(localStorage.getItem(UXRW_KEY)||'[]')}catch{return[]}}
function esc(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function icon(type){return type==='vehicle'?'▦':type==='driver'?'♙':'▤'}
function typeLabel(type){return type==='vehicle'?'Техника':type==='driver'?'Водитель':'ПЛ'}
function renderRecent(){
  if(document.body.dataset.role!=='admin'||document.body.dataset.view!=='home')return;
  const main=document.querySelector('.main');
  if(!main||main.querySelector('.uxrw-section'))return;
  const rows=readRecent().filter(x=>x?.title).slice(0,3);
  if(!rows.length)return;
  const section=document.createElement('section');
  section.className='uxrw-section';
  section.dataset.uxrw=UXRW_VERSION;
  section.innerHTML=`<h2 class="section-title">Продолжить работу</h2><div class="uxrw-grid">${rows.map(x=>`<button type="button" class="uxrw-item" data-uxrw-query="${esc(x.title)}"><span class="uxrw-icon" aria-hidden="true">${icon(x.type)}</span><span class="uxrw-copy"><span class="uxrw-title">${esc(x.title)}</span><span class="uxrw-sub">${esc(x.sub||'')}</span></span><span class="uxrw-type">${typeLabel(x.type)}</span></button>`).join('')}</div>`;
  const quick=[...main.querySelectorAll('.section')].find(s=>(s.querySelector('.section-title')?.textContent||'').includes('Быстрые действия'));
  if(quick)quick.insertAdjacentElement('beforebegin',section);else main.appendChild(section);
}
function openInSearch(query){
  document.querySelector('[data-uxgs-open]')?.click();
  setTimeout(()=>{
    const input=document.querySelector('.uxgs-search input');
    if(!input)return;
    input.value=query;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.focus();
  },0);
}
window.addEventListener('fleet:ui-ready',renderRecent);
document.addEventListener('click',e=>{const b=e.target.closest('[data-uxrw-query]');if(b){e.preventDefault();openInSearch(b.dataset.uxrwQuery||'')}},true);
queueMicrotask(renderRecent);
