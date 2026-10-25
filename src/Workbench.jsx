import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {Activity,AlertTriangle,ArrowRight,Ban,Check,CircleCheck,Clock3,FileImage,Globe,Inbox,Instagram,Keyboard,Landmark,LoaderCircle,MessageCircle,Mic,Music2,Network,Pause,Play,RotateCcw,Send,ShieldAlert,Sparkles,Users,X,Youtube,Radio,Workflow,BrainCircuit,Info,Layers,Search,Plus,ExternalLink,Trash2,Telescope} from 'lucide-react';
import {getLanguage} from './i18n.js';
import './workbench.css';

const L=(ru,kk)=>getLanguage()==='kk'?kk:ru;
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;}

// Tracks follow the hackathon brief; colours are validated for colour-blind separation and always shown with a name.
export const TRACKS={
 lottery:{n:1,ru:'Розыгрыши под контролем',kk:'Бақылаудағы ұтыстар',shortRu:'Платные розыгрыши',shortKk:'Ақылы ұтыстар'},
 casino:{n:2,ru:'Скрытая игра',kk:'Жасырын ойын',shortRu:'Скрытое казино',shortKk:'Жасырын казино'},
 pyramid:{n:3,ru:'Стоп-пирамида',kk:'Пирамидаға тосқауыл',shortRu:'Финансовые пирамиды',shortKk:'Қаржы пирамидалары'},
 phishing:{n:null,ru:'Фишинг',kk:'Фишинг',shortRu:'Фишинг',shortKk:'Фишинг'},
 none:{n:null,ru:'Нет признаков',kk:'Белгі жоқ',shortRu:'Нет признаков',shortKk:'Белгі жоқ'},
};
const LEVEL={high:['Высокий','Жоғары'],medium:['Средний','Орташа'],low:['Низкий','Төмен']};
const KIND={post:['Пост','Жазба'],reel:['Reels','Reels'],story:['Сторис','Сторис'],stream:['Эфир','Эфир'],channel_post:['Пост канала','Арна жазбасы'],comment:['Комментарий','Пікір'],group:['Группа','Топ'],caption:['Подпись','Жазба']};
const ROLE={organizer:['Организатор','Ұйымдастырушы'],curator:['Куратор','Куратор'],testimonial:['Отзыв','Пікір'],member:['Участник','Қатысушы'],skeptic:['Сомневается','Күмәнданады'],bot:['Бот','Бот']};
const MODALITY={text:['Подпись','Жазба',MessageCircle],ocrText:['Скриншот (OCR)','Скриншот (OCR)',FileImage],transcript:['Эфир (речь)','Эфир (сөйлеу)',Mic]};
const DISMISS=[['free_contest','Обычный бесплатный конкурс','Кәдімгі тегін байқау'],['legal_ad','Легальная реклама','Заңды жарнама'],['news_warning','Новость или предупреждение','Жаңалық не ескерту'],['insufficient','Недостаточно признаков','Белгілер жеткіліксіз'],['other','Другое','Басқа']];
const trackName=id=>L(TRACKS[id]?.shortRu??id,TRACKS[id]?.shortKk??id);
const levelName=level=>L(...(LEVEL[level]??[level,level]));
const kindName=kind=>L(...(KIND[kind]??[kind||'Пост',kind||'Жазба']));
const percent=value=>value==null?'—':`${Math.round(value*1000)/10}%`;
const number=value=>new Intl.NumberFormat(getLanguage()==='kk'?'kk-KZ':'ru-RU').format(value??0);
function ago(iso){if(!iso)return '';const minutes=Math.max(0,Math.round((Date.now()-Date.parse(iso))/60000));if(minutes<1)return L('только что','жаңа ғана');if(minutes<60)return L(`${minutes} мин назад`,`${minutes} мин бұрын`);const hours=Math.round(minutes/60);if(hours<48)return L(`${hours} ч назад`,`${hours} сағ бұрын`);return L(`${Math.round(hours/24)} дн назад`,`${Math.round(hours/24)} күн бұрын`);}
function localSignals(analysis){const lang=getLanguage()==='kk'?'kk':'ru';const map=new Map((analysis?.translations?.[lang]?.signals??[]).map(item=>[item.id,item]));return (analysis?.signals??[]).map(signal=>({...signal,...(map.get(signal.id)?{label:map.get(signal.id).label,description:map.get(signal.id).description}:{})}));}
function usePoll(path,interval,deps=[]){const [data,setData]=useState(null),[error,setError]=useState('');const load=useCallback(async()=>{try{setData(await api(path));setError('');}catch(e){setError(e.message);}},[path]);useEffect(()=>{load();if(!interval)return;const timer=setInterval(load,typeof interval==='function'?interval():interval);return()=>clearInterval(timer);},[load,...deps]);return [data,load,error];}

export function PlatformIcon({platform,size=14}){const Icon={instagram:Instagram,tiktok:Music2,telegram:Send,whatsapp:MessageCircle,youtube:Youtube}[platform]??Globe;return <span className={`wb-platform ${platform||'other'}`} title={platform}><Icon size={size} aria-hidden/></span>;}
export function TrackTag({category,full=false}){if(!TRACKS[category]||category==='none')return <span className="wb-track none">{trackName('none')}</span>;const meta=TRACKS[category];return <span className={`wb-track ${category}`}><i aria-hidden/>{meta.n?`${L('Трек','Трек')} ${meta.n} · `:''}{full?L(meta.ru,meta.kk):trackName(category)}</span>;}
export function ScoreDial({score=0,level='low',size=46}){const r=size/2-4,c=2*Math.PI*r,offset=c*(1-Math.min(100,score)/100);return <span className={`wb-dial ${level}`} style={{width:size,height:size}} role="img" aria-label={`${L('Риск','Тәуекел')} ${score}/100, ${levelName(level)}`}><svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden><circle cx={size/2} cy={size/2} r={r} className="track"/><circle cx={size/2} cy={size/2} r={r} className="value" strokeDasharray={c} strokeDashoffset={offset} transform={`rotate(-90 ${size/2} ${size/2})`}/></svg><b style={{fontSize:Math.round(size*0.31)}}>{score}</b></span>;}
function LevelText({level}){const Icon=level==='high'?ShieldAlert:level==='medium'?AlertTriangle:Check;return <span className={`wb-level ${level}`}><Icon size={13} aria-hidden/>{levelName(level)}</span>;}

/** Marks every quote inside the text; overlapping quotes merge into one mark. */
function Highlighted({text,quotes}){
 const ranges=[];for(const {quote,category} of quotes){if(!quote||quote.length<2)continue;const index=text.indexOf(quote);if(index>=0)ranges.push([index,index+quote.length,category]);}
 ranges.sort((a,b)=>a[0]-b[0]);const merged=[];for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
 const parts=[];let cursor=0;merged.forEach(([start,end,category],i)=>{if(start>cursor)parts.push(text.slice(cursor,start));parts.push(<mark key={i} className={`wb-mark ${category}`}>{text.slice(start,end)}</mark>);cursor=end;});if(cursor<text.length)parts.push(text.slice(cursor));
 return <p className="wb-evidence-text">{parts}</p>;
}

// ——— Overview: the funnel is the product's job — the machine reads everything, people see only what needs them.
export function CommandCenter({go,onOpen}){
 const [pipeline]=usePoll('/api/pipeline?limit=0',2500);
 const [queue]=usePoll('/api/queue',4000);
 const [metrics]=usePoll('/api/metrics',0);
 const [review]=usePoll('/api/review-stats',8000);
 const processed=pipeline?.processed??0,cleared=pipeline?.cleared??0,queued=pipeline?.queued??0,decided=review?.total??0;
 const open=queue?.open??[];
 const demoOpen=(queue?.open??[]).filter(c=>c.demo).length,realOpen=(queue?.open??[]).length-demoOpen;
 const holdout=metrics?.test?.splits?.holdout,rulesHoldout=metrics?.rulesOnly?.test?.splits?.holdout;
 const rows=[
  {id:'processed',value:processed,label:L('публикаций, эфиров и групп система проверила сама','жарияланымды, эфирді және топты жүйе өзі тексерді'),share:1},
  {id:'cleared',value:cleared,label:L('отсеяно без участия человека — признаков схем нет','адамсыз сүзілді — схема белгілері жоқ'),share:processed?cleared/processed:0},
  {id:'queued',value:queued,label:L('передано аналитику с объяснением, почему','талдаушыға себебімен берілді'),share:processed?queued/processed:0},
  {id:'decided',value:decided,label:L('уже решено человеком','адам шешім қабылдады'),share:processed?decided/processed:0},
 ];
 const byTrack=Object.fromEntries(['lottery','casino','pyramid'].map(id=>[id,open.filter(c=>c.analysis?.category===id)]));
 const hints={lottery:[['Платное участие','Ақылы қатысу'],['Случайный выбор победителя','Кездейсоқ таңдау'],['Доход организатора','Ұйымдастырушы табысы']],casino:[['Промокоды и рефссылки','Промокод пен рефсілтеме'],['Зеркала и посредники','Айналар мен делдалдар'],['«Мой выигрыш», стримы','«Менің ұтысым», стримдер']],pyramid:[['Нереалистичная доходность','Шынайы емес табыс'],['Kaspi на личную карту','Жеке картаға Kaspi'],['Кураторы и шаблоны','Кураторлар мен үлгілер']]};
 return <div className="wb">
  <section className="wb-hero">
   <div className="wb-hero-copy">
    <p className="wb-live">{pipeline?.running?<><i className="wb-pulse"/>{L(`Поток идёт: ${pipeline.rate} публ./сек`,`Ағын жүріп жатыр: ${pipeline.rate} жар./сек`)}</>:pipeline?.finished?<><CircleCheck size={15}/>{L('Демо-поток обработан полностью','Демо-ағын толық өңделді')}</>:<><Pause size={15}/>{L('Поток на паузе','Ағын кідіртілді')}</>}</p>
    <h2>{L('Машина читает всё. Человек смотрит только то, что требует решения.','Машина бәрін оқиды. Адам тек шешімді қажет ететінін көреді.')}</h2>
    {demoOpen>0&&<p className="wb-demo-banner">{L(`В очереди ${demoOpen} синтетических демо-случаев и ${realOpen} настоящих — из публичного Telegram (автопоиск и мониторинг), расширения и ручной проверки.`,`Кезекте ${demoOpen} синтетикалық демо-жағдай және ${realOpen} нақты жағдай — ашық Telegram-нан (автоіздеу мен мониторинг), кеңейтімнен және қолмен тексеруден.`)}</p>}
    <p>{L('Система ищет признаки платных розыгрышей, скрытой рекламы казино и финансовых пирамид, считает риск и объясняет каждое срабатывание. Решение о законности принимает аналитик.','Жүйе ақылы ұтыстардың, жасырын казино жарнамасының және қаржы пирамидаларының белгілерін іздейді, тәуекелді есептейді және әр белгіні түсіндіреді. Заңдылық туралы шешімді талдаушы қабылдайды.')}</p>
    <div className="wb-actions"><button className="wb-button primary" onClick={()=>go('review')}><Inbox size={17}/>{L(`Открыть очередь · ${open.length}`,`Кезекті ашу · ${open.length}`)}</button><button className="wb-button" onClick={()=>go('pipeline')}><Workflow size={17}/>{L('Смотреть поток','Ағынды көру')}</button></div>
   </div>
   <ol className="wb-funnel" aria-label={L('Воронка автоматической проверки','Автоматты тексеру воронкасы')}>
    {rows.map(row=><li key={row.id} className={row.id}><div className="wb-funnel-bar" style={{'--share':Math.max(row.share,row.value?0.04:0)}}/><strong>{number(row.value)}</strong><span>{row.label}</span>{row.id!=='processed'&&processed>0&&<em>{percent(row.share)}</em>}</li>)}
   </ol>
  </section>
  <section className="wb-tracks">
   {['lottery','casino','pyramid'].map(id=>{const items=byTrack[id];const high=items.filter(c=>c.analysis.level==='high').length;return <button key={id} className={`wb-track-card ${id}`} onClick={()=>go('review',{track:id})}>
    <TrackTag category={id} full/>
    <strong>{items.length}</strong><span>{L('в очереди','кезекте')}{high>0&&<> · <b>{high}</b> {L('высокий риск','жоғары тәуекел')}</>}</span>
    <ul>{hints[id].map(([ru,kk])=><li key={ru}>{L(ru,kk)}</li>)}</ul>
   </button>;})}
  </section>
  <div className="wb-split">
   <section className="wb-panel">
    <header><h3>{L('Самое срочное','Ең шұғыл')}</h3><button className="wb-link" onClick={()=>go('review')}>{L('Вся очередь','Барлық кезек')}<ArrowRight size={14}/></button></header>
    {open.length?<ul className="wb-mini-queue">{open.slice(0,6).map(item=><li key={item.id}><button onClick={()=>onOpen(item.id)}><ScoreDial score={item.analysis.score} level={item.analysis.level} size={38}/><span className="wb-mini-main"><strong>{item.author||L('Без автора','Авторсыз')}</strong><small><PlatformIcon platform={item.platform} size={12}/>{kindName(item.kind)} · {ago(item.createdAt)}</small></span><TrackTag category={item.analysis.category}/></button></li>)}</ul>:<p className="wb-empty">{L('Очередь пуста: всё проверенное либо отсеяно, либо уже решено.','Кезек бос: тексерілгеннің бәрі сүзілді не шешілді.')}</p>}
   </section>
   <section className="wb-panel wb-quality-mini">
    <header><h3>{L('Качество на слепой выборке','Соқыр іріктемедегі сапа')}</h3><button className="wb-link" onClick={()=>go('quality')}>{L('Подробно','Толығырақ')}<ArrowRight size={14}/></button></header>
    {holdout?<><dl className="wb-kpis"><div><dt>Precision</dt><dd>{percent(holdout.precision)}</dd></div><div><dt>Recall</dt><dd>{percent(holdout.recall)}</dd></div><div><dt>{L('Ложные срабатывания','Жалған белгілер')}</dt><dd>{percent(holdout.falsePositiveRate)}</dd></div></dl>
     <p className="wb-note">{L(`Отложенная часть независимой выборки (${holdout.total} примеров), которую не видели ни правила, ни модель. Только правила: precision ${percent(rulesHoldout?.precision)}, recall ${percent(rulesHoldout?.recall)}.`,`Ережелер де, модель де көрмеген тәуелсіз іріктеменің бөлігі (${holdout.total} мысал). Тек ережелер: precision ${percent(rulesHoldout?.precision)}, recall ${percent(rulesHoldout?.recall)}.`)}</p></>:<p className="wb-empty">{L('Запустите npm run evaluate.','npm run evaluate іске қосыңыз.')}</p>}
   </section>
  </div>
  <p className="wb-principle"><Info size={15}/>{L('Система не объявляет схему незаконной. Она показывает признаки возможного нарушения; законность проверяет человек с учётом законодательства Республики Казахстан.','Жүйе схеманы заңсыз деп жарияламайды. Ол ықтимал бұзушылық белгілерін көрсетеді; заңдылықты адам Қазақстан Республикасының заңнамасын ескере отырып тексереді.')}</p>
 </div>;
}

// ——— Review queue: the analyst's only job is to confirm, escalate or dismiss — with the evidence in front of them.
export function ReviewQueue({initialCase,initialTrack,onChanged}){
 const [data,reload]=usePoll('/api/queue',6000);
 const [tab,setTab]=useState('open'),[track,setTrack]=useState(initialTrack||'all'),[band,setBand]=useState('all'),[selectedId,setSelectedId]=useState(initialCase||null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const list=useMemo(()=>{const source=tab==='open'?(data?.open??[]):(data?.reviewed??[]);return source.filter(item=>(track==='all'||item.analysis?.category===track)&&(band==='all'||(band==='model')===Boolean(item.analysis?.signals?.some(s=>s.id==='ml_model'))));},[data,tab,track,band]);
 const selected=list.find(item=>item.id===selectedId)??list[0]??null;
 useEffect(()=>{if(initialCase)setSelectedId(initialCase);},[initialCase]);
 useEffect(()=>{if(initialTrack)setTrack(initialTrack);},[initialTrack]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(timer);},[notice]);
 const move=useCallback(step=>{if(!list.length)return;const index=Math.max(0,list.findIndex(item=>item.id===selected?.id));const next=list[Math.min(list.length-1,Math.max(0,index+step))];if(!next)return;setSelectedId(next.id);document.querySelector(`[data-case="${next.id}"]`)?.scrollIntoView({block:'nearest'});},[list,selected]);
 const decide=useCallback(async(status,reason,note)=>{
  if(!selected||busy)return;setBusy(true);
  const index=list.findIndex(item=>item.id===selected.id);const following=list[index+1]??list[index-1];
  try{await api(`/api/cases/${encodeURIComponent(selected.id)}`,{method:'PATCH',body:JSON.stringify({status,reason,note})});setNotice(status==='dismissed'?L('Отмечено как ложное срабатывание','Жалған белгі деп белгіленді'):status==='escalated'?L('Передано в профильное ведомство','Бейінді ведомствоға берілді'):L('Признаки подтверждены','Белгілер расталды'));setSelectedId(following?.id??null);await reload();onChanged?.();}
  catch(e){setNotice(e.message);}finally{setBusy(false);}
 },[selected,busy,list,reload,onChanged]);
 useEffect(()=>{const onKey=event=>{if(/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)||event.metaKey||event.ctrlKey||event.altKey)return;if(event.key==='j'||event.key==='ArrowDown'){event.preventDefault();move(1);}if(event.key==='k'||event.key==='ArrowUp'){event.preventDefault();move(-1);}if(tab!=='open')return;if(event.key==='1')decide('confirmed','signs_confirmed');if(event.key==='2')decide('escalated','to_agency');};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[move,decide,tab]);
 const counts=data?.counts;
 return <div className="wb wb-review">
  <div className="wb-review-bar">
   <div className="wb-tabs" role="tablist"><button role="tab" aria-selected={tab==='open'} onClick={()=>setTab('open')}>{L('Ждут решения','Шешім күтуде')} <b>{counts?.open??0}</b></button><button role="tab" aria-selected={tab==='reviewed'} onClick={()=>setTab('reviewed')}>{L('Решённые','Шешілгендер')} <b>{counts?.reviewed??0}</b></button></div>
   <div className="wb-filters">
    <select value={track} onChange={e=>setTrack(e.target.value)} aria-label={L('Трек','Трек')}><option value="all">{L('Все треки','Барлық трек')}</option>{['lottery','casino','pyramid','phishing'].map(id=><option key={id} value={id}>{trackName(id)}</option>)}</select>
    <select value={band} onChange={e=>setBand(e.target.value)} aria-label={L('Кто поднял','Кім көтерді')}><option value="all">{L('Правила и модель','Ережелер мен модель')}</option><option value="rules">{L('Подтверждено правилами','Ережелер растады')}</option><option value="model">{L('Только модель','Тек модель')}</option></select>
   </div>
   <p className="wb-hint"><Keyboard size={14}/>J/K — {L('следующий/предыдущий','келесі/алдыңғы')} · 1 — {L('подтвердить','растау')} · 2 — {L('передать','беру')}</p>
  </div>
  <div className="wb-review-grid">
   <aside className="wb-queue" aria-label={L('Очередь','Кезек')}>
    {!data?<p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Загрузка очереди…','Кезек жүктелуде…')}</p>:!list.length?<p className="wb-empty">{tab==='open'?L('Нет случаев, ожидающих решения. Автопоток продолжит пополнять очередь.','Шешім күтетін жағдай жоқ. Автоағын кезекті толықтыра береді.'):L('Решённых случаев пока нет.','Шешілген жағдай әзірге жоқ.')}</p>:
    <ul>{list.map(item=>{const model=item.analysis?.signals?.some(s=>s.id==='ml_model');return <li key={item.id}><button data-case={item.id} className={item.id===selected?.id?'active':''} onClick={()=>setSelectedId(item.id)}>
     <ScoreDial score={item.analysis.score} level={item.analysis.level} size={40}/>
     <span className="wb-q-main"><span className="wb-q-top"><strong>{item.author||L('Без автора','Авторсыз')}</strong><small>{ago(item.createdAt)}</small></span><span className="wb-q-text">{(item.text||item.ocrText||item.transcript||'').slice(0,110)}</span>
      <span className="wb-q-meta"><b className={`wb-q-level ${item.analysis.level}`}>{levelName(item.analysis.level)}</b><PlatformIcon platform={item.platform} size={12}/><span>{kindName(item.kind)}</span>{item.ocrText&&<FileImage size={12} aria-label="OCR"/>}{item.transcript&&<Mic size={12} aria-label="ASR"/>}{item.network&&<Network size={12} aria-label={L('Сеть','Желі')}/>}<TrackTag category={item.analysis.category}/>{model&&<span className="wb-badge model">{L('только модель','тек модель')}</span>}{item.demo&&<span className="wb-badge demo" title={L('Вымышленный аккаунт из синтетического демо-потока','Синтетикалық демо-ағындағы ойдан шығарылған аккаунт')}>{L('демо','демо')}</span>}{item.review&&<span className={`wb-badge ${item.review.decision}`}>{item.review.decision==='dismissed'?L('ложное','жалған'):item.review.decision==='escalated'?L('передано','берілді'):L('подтверждено','расталды')}</span>}</span></span>
    </button></li>;})}</ul>}
   </aside>
   <section className="wb-dossier" aria-live="polite">{selected?<Dossier key={selected.id} item={selected} busy={busy} onDecide={tab==='open'?decide:null}/>:<p className="wb-empty">{L('Выберите случай слева.','Сол жақтан жағдайды таңдаңыз.')}</p>}</section>
  </div>
  {notice&&<div className="wb-toast" role="status"><CircleCheck size={17}/>{notice}</div>}
 </div>;
}

function Dossier({item,busy,onDecide}){
 const analysis=item.analysis||{};const signals=localSignals(analysis);const positive=signals.filter(s=>s.weight>0);const context=signals.filter(s=>!s.weight);
 const parts=[['text',item.text],['ocrText',item.ocrText],['transcript',item.transcript]].filter(([,value])=>value);
 // Open the modality that carries most of the evidence (often the stream transcript or screenshot, not the caption).
 const [part,setPart]=useState(()=>parts.map(([key])=>[key,signals.filter(s=>s.modality===key&&s.weight>0).length]).sort((a,b)=>b[1]-a[1])[0]?.[0]??'text');const [dismissing,setDismissing]=useState(false);const [note,setNote]=useState('');
 const maxWeight=Math.max(1,...positive.map(s=>s.weight));
 const model=analysis.model;const kk=getLanguage()==='kk';
 const quotesFor=key=>signals.filter(s=>s.quote&&(s.modality===key||!s.modality)).map(s=>({quote:s.quote,category:s.category}));
 return <article className="wb-case">
  <header className="wb-case-head">
   <ScoreDial score={analysis.score} level={analysis.level} size={64}/>
   <div><p className="wb-case-meta"><PlatformIcon platform={item.platform}/>{item.author||L('Без автора','Авторсыз')}<span>{kindName(item.kind)}</span>{item.followers?<span><Users size={12}/>{number(item.followers)}</span>:null}<span><Clock3 size={12}/>{ago(item.publishedAt||item.createdAt)}</span></p>
    <h2><TrackTag category={analysis.category} full/></h2>
    {item.demo&&<p className="wb-demo-note">{L('Синтетический демо-пример: аккаунт, реквизиты и ссылки вымышлены.','Синтетикалық демо-мысал: аккаунт, деректемелер мен сілтемелер ойдан шығарылған.')}</p>}
    <p className="wb-case-level"><LevelText level={analysis.level}/>{L(`риск ${analysis.score}/100`,`тәуекел ${analysis.score}/100`)}{item.priorityParts&&<span className="wb-priority">{L('Приоритет','Басымдық')} {item.priority}: {L('риск','тәуекел')} {item.priorityParts.risk} + {L('охват','қамту')} {item.priorityParts.reach}{item.priorityParts.network?` + ${L('сеть','желі')} ${item.priorityParts.network}`:''}</span>}</p></div>
  </header>

  {analysis.elements?.length>0&&<section className="wb-elements" aria-label={L('Состав схемы','Схема құрамы')}>
   <h3>{L('Какие элементы схемы найдены','Схеманың қандай элементтері табылды')}</h3>
   <ul>{analysis.elements.map(element=><li key={element.id} className={element.present?'on':''}><span className="wb-el-icon">{element.present?<Check size={14}/>:<X size={14}/>}</span><strong>{kk?element.label.kk:element.label.ru}</strong>{element.present?<small>«{element.evidence[0]}»</small>:<small>{L('не найдено','табылмады')}</small>}</li>)}</ul>
  </section>}

  <section className="wb-block">
   <h3>{L('Материал','Материал')}</h3>
   {item.kind==='group'&&item.group?<GroupEvidence group={item.group} signals={signals}/>:<>
    {parts.length>1&&<div className="wb-tabs small" role="tablist">{parts.map(([key])=>{const [ru,kz,Icon]=MODALITY[key];return <button key={key} role="tab" aria-selected={part===key} onClick={()=>setPart(key)}><Icon size={13}/>{L(ru,kz)}</button>;})}</div>}
    {parts.filter(([key])=>key===part).map(([key,value])=><Highlighted key={key} text={value} quotes={quotesFor(key)}/>)}
    {item.imageNote&&<p className="wb-note"><FileImage size={13}/>{item.imageNote}</p>}
   </>}
   {item.url&&<p className="wb-url"><Globe size={13}/><span>{item.url}</span><small>{L('ссылка не открывалась','сілтеме ашылмады')}</small></p>}
  </section>

  <section className="wb-block">
   <h3>{L('Из чего сложился балл','Балл неден құралды')}</h3>
   <ul className="wb-signals">{positive.map(signal=><li key={`${signal.id}-${signal.category}`}><div className="wb-sig-head"><strong>{signal.label}</strong><span className="wb-weight">+{signal.weight}</span></div><div className="wb-sig-bar"><i className={signal.category} style={{width:`${(signal.weight/maxWeight)*100}%`}}/></div><p>{signal.description}</p>{signal.quote&&<blockquote>«{signal.quote}»{signal.modality&&MODALITY[signal.modality]&&<small> · {L(MODALITY[signal.modality][0],MODALITY[signal.modality][1])}</small>}</blockquote>}</li>)}</ul>
   {context.map(signal=><p key={signal.id} className="wb-context"><Info size={14}/><span><b>{signal.label}.</b> {signal.description}</span></p>)}
  </section>

  {item.network&&<section className="wb-block">
   <h3><Network size={15}/>{L(`Связанные аккаунты: ${item.network.size}`,`Байланысқан аккаунттар: ${item.network.size}`)}</h3>
   <div className="wb-chips">{item.network.shared.map(shared=><span key={shared.type+shared.value} className="wb-chip"><small>{kk?shared.label.kk:shared.label.ru}</small>{shared.value}<em>×{shared.accounts}</em></span>)}</div>
   <ul className="wb-accounts">{item.network.accounts.map(account=><li key={account.handle}><PlatformIcon platform={account.platform} size={12}/>{account.handle}{account.risky>0&&<small>{L(`помечено: ${account.risky}`,`белгіленген: ${account.risky}`)}</small>}</li>)}</ul>
   <p className="wb-note">{L('Совпадение реквизитов, промокодов или доменов — повод проверить связь, а не доказательство общего владельца.','Деректемелердің, промокодтардың не домендердің сәйкестігі — байланысты тексеру себебі, ортақ иенің дәлелі емес.')}</p>
  </section>}

  {model&&<section className="wb-block wb-model">
   <h3><BrainCircuit size={15}/>{L('Второе мнение: статистическая модель','Екінші пікір: статистикалық модель')}</h3>
   <div className="wb-probs">{['lottery','casino','pyramid','none'].map(id=><div key={id}><span>{trackName(id)}</span><div className="wb-prob-bar"><i className={id} style={{width:`${(model.probabilities?.[id]??0)*100}%`}}/></div><b>{Math.round((model.probabilities?.[id]??0)*100)}%</b></div>)}</div>
   {model.topTerms?.length>0&&<p className="wb-note">{L('Сильнее всего повлияли слова:','Ең көп әсер еткен сөздер:')} {model.topTerms.slice(0,5).map(term=><code key={term}>{term}</code>)}</p>}
  </section>}

  <details className="wb-limits"><summary>{L('Ограничения анализа','Талдау шектеулері')}</summary><ul>{(analysis.translations?.[kk?'kk':'ru']?.limitations??analysis.limitations??[]).map(text=><li key={text}>{text}</li>)}</ul></details>

  {onDecide?<footer className="wb-decision">
   {!dismissing?<>
    <button className="wb-button confirm" disabled={busy} onClick={()=>onDecide('confirmed','signs_confirmed',note)}><Check size={16}/>{L('Подтвердить признаки','Белгілерді растау')}<kbd>1</kbd></button>
    <button className="wb-button escalate" disabled={busy} onClick={()=>onDecide('escalated','to_agency',note)}><Landmark size={16}/>{L('Передать в ведомство','Ведомствоға беру')}<kbd>2</kbd></button>
    <button className="wb-button ghost" disabled={busy} onClick={()=>setDismissing(true)}><Ban size={16}/>{L('Ложное срабатывание','Жалған белгі')}</button>
    <input className="wb-note-input" value={note} onChange={e=>setNote(e.target.value)} placeholder={L('Комментарий для отчёта (необязательно)','Есепке пікір (міндетті емес)')} aria-label={L('Комментарий','Пікір')}/>
   </>:<div className="wb-reasons"><span>{L('Почему это не схема?','Неге бұл схема емес?')}</span>{DISMISS.map(([id,ru,kz])=><button key={id} className="wb-button ghost" disabled={busy} onClick={()=>onDecide('dismissed',id,note)}>{L(ru,kz)}</button>)}<button className="wb-link" onClick={()=>setDismissing(false)}>{L('Отмена','Болдырмау')}</button></div>}
  </footer>:item.review&&<footer className="wb-decision done"><CircleCheck size={16}/>{item.review.decision==='dismissed'?L('Отмечено как ложное срабатывание','Жалған белгі деп белгіленді'):item.review.decision==='escalated'?L('Передано в профильное ведомство','Бейінді ведомствоға берілді'):L('Признаки подтверждены','Белгілер расталды')}{item.review.reason&&<small>· {DISMISS.find(([id])=>id===item.review.reason)?.[kk?2:1]??item.review.reason}</small>}{item.review.note&&<small>· {item.review.note}</small>}</footer>}
 </article>;
}

function GroupEvidence({group,signals}){
 const quotes=signals.filter(s=>s.quote).map(s=>({quote:s.quote,category:s.category}));
 const visible=group.roles.filter(role=>role.role!=='member');
 return <div className="wb-group">
  <p className="wb-group-title"><Users size={14}/>{group.title} · {L(`${group.messageCount} сообщений`,`${group.messageCount} хабарлама`)}</p>
  {visible.length>0&&<ul className="wb-roles">{visible.map(role=><li key={role.id} className={role.role}><b>{L(...ROLE[role.role])}</b>{role.name}<small>{L(`${role.messages} сообщ.`,`${role.messages} хаб.`)}{role.requisites?` · ${L('реквизиты','деректемелер')}`:''}</small></li>)}</ul>}
  <ul className="wb-messages">{group.evidence.map(message=><li key={message.id}><b>{message.author}</b><Highlighted text={message.text||''} quotes={quotes}/>{message.ocrText&&<p className="wb-note"><FileImage size={12}/>{message.ocrText}</p>}</li>)}</ul>
  {group.templates?.length>0&&<div className="wb-template"><Layers size={14}/><span>{L(`Шаблон: ${group.templates[0].size} почти одинаковых сообщений от ${group.templates[0].authors} авторов`,`Үлгі: ${group.templates[0].authors} автордан ${group.templates[0].size} ұқсас хабарлама`)}</span><q>{group.templates[0].example.slice(0,140)}</q></div>}
  {group.counterMessages?.length>0&&<p className="wb-note">{L('Участники предупреждают:','Қатысушылар ескертеді:')} «{group.counterMessages[0].text.slice(0,120)}» — {group.counterMessages[0].author}</p>}
 </div>;
}

// ——— Pipeline: what the machine is doing right now, stage by stage.
export function PipelinePage({go}){
 const [running,setRunning]=useState(true);
 const [data,reload]=usePoll('/api/pipeline?limit=60',()=>running?1500:6000,[running]);
 useEffect(()=>{if(data)setRunning(Boolean(data.running));},[data?.running]);
 const [busy,setBusy]=useState(false);
 const act=async(path,options)=>{setBusy(true);try{await api(path,options);await reload();}finally{setBusy(false);}};
 if(!data)return <div className="wb"><p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Подключение к потоку…','Ағынға қосылу…')}</p></div>;
 const progress=data.total?data.cursor/data.total:0;
 const stages=[
  {icon:Radio,title:L('Источники','Дереккөздер'),value:`${data.corpus.items} + ${data.corpus.groups}`,note:L('публикаций и групп в демо-потоке','демо-ағындағы жарияланым мен топ')},
  {icon:FileImage,title:L('Распознавание','Тану'),value:`${data.byModality.ocrText??0} / ${data.byModality.transcript??0}`,note:L('скриншотов (OCR) / эфиров (речь)','скриншот (OCR) / эфир (сөйлеу)')},
  {icon:Sparkles,title:L('Признаки','Белгілер'),value:L('правила + модель','ережелер + модель'),note:L('3 трека, RU / KK / транслит','3 трек, RU / KK / транслит')},
  {icon:Network,title:L('Связи','Байланыстар'),value:L('сети аккаунтов','аккаунт желілері'),note:L('промокоды, реквизиты, домены, шаблоны','промокод, деректеме, домен, үлгі')},
  {icon:Workflow,title:L('Маршрут','Бағыт'),value:`${data.cleared} / ${data.queued}`,note:L(`отсеяно / в очередь (порог ${data.threshold})`,`сүзілді / кезекке (шек ${data.threshold})`)},
  {icon:Inbox,title:L('Аналитик','Талдаушы'),value:data.queued,note:L('случаев с объяснением','түсіндірмесі бар жағдай')},
 ];
 return <div className="wb wb-pipeline">
  <section className="wb-panel wb-pipe-head">
   <div><p className="wb-live">{data.running?<><i className="wb-pulse"/>{L('Идёт автоматическая проверка','Автоматты тексеру жүріп жатыр')}</>:data.finished?<><CircleCheck size={15}/>{L('Демо-поток обработан','Демо-ағын өңделді')}</>:<><Pause size={15}/>{L('Пауза','Кідіріс')}</>}</p>
    <h2>{number(data.processed)} <span>{L(`из ${number(data.total)} обработано`,`${number(data.total)} ішінен өңделді`)}</span></h2>
    <div className="wb-progress" role="progressbar" aria-valuenow={Math.round(progress*100)} aria-valuemin={0} aria-valuemax={100}><i style={{width:`${progress*100}%`}}/></div>
    <dl className="wb-kpis small"><div><dt>{L('Отсеяно автоматически','Автоматты сүзілді')}</dt><dd>{number(data.cleared)}</dd></div><div><dt>{L('В очередь аналитику','Талдаушы кезегіне')}</dt><dd>{number(data.queued)}</dd></div><div><dt>{L('Задержка анализа','Талдау кідірісі')}</dt><dd>{data.avgLatencyMs} {L('мс','мс')}</dd></div><div><dt>{L('Время работы','Жұмыс уақыты')}</dt><dd>{data.elapsedSeconds} {L('с','с')}</dd></div></dl>
   </div>
   <div className="wb-pipe-controls">
    {data.enabled&&!data.finished?<button className="wb-button" disabled={busy} onClick={()=>act('/api/pipeline',{method:'PUT',body:JSON.stringify({enabled:false})})}><Pause size={16}/>{L('Пауза','Кідірту')}</button>:!data.finished&&<button className="wb-button primary" disabled={busy} onClick={()=>act('/api/pipeline',{method:'PUT',body:JSON.stringify({enabled:true})})}><Play size={16}/>{L('Продолжить','Жалғастыру')}</button>}
    <label className="wb-select-label">{L('Скорость','Жылдамдық')}<select value={data.rate} onChange={e=>act('/api/pipeline',{method:'PUT',body:JSON.stringify({rate:Number(e.target.value)})})}>{[1,2,5,10,25].map(rate=><option key={rate} value={rate}>{rate} {L('публ./сек','жар./сек')}</option>)}</select></label>
    <button className="wb-button ghost" disabled={busy} onClick={()=>{if(confirm(L('Перезапустить демо-поток? Необработанные демо-случаи будут заменены, решения аналитика сохранятся.','Демо-ағынды қайта бастау керек пе? Өңделмеген демо-жағдайлар ауыстырылады, талдаушы шешімдері сақталады.')))act('/api/pipeline/reset',{method:'POST',body:'{}'});}}><RotateCcw size={16}/>{L('Перезапустить демо','Демоны қайта бастау')}</button>
   </div>
  </section>
  <ol className="wb-stages">{stages.map((stage,i)=><li key={i}><stage.icon size={18}/><strong>{stage.title}</strong><b>{stage.value}</b><small>{stage.note}</small></li>)}</ol>
  <div className="wb-split wide">
   <section className="wb-panel">
    <header><h3>{L('Последние решения системы','Жүйенің соңғы шешімдері')}</h3><span className="wb-note">{L('обновляется автоматически','автоматты жаңарады')}</span></header>
    <table className="wb-log"><thead><tr><th>{L('Источник','Дереккөз')}</th><th>{L('Фрагмент','Үзінді')}</th><th>{L('Риск','Тәуекел')}</th><th>{L('Решение','Шешім')}</th></tr></thead>
     <tbody>{data.log.map(entry=><tr key={entry.id} className={entry.decision}><td><PlatformIcon platform={entry.platform} size={12}/><span className="wb-log-handle">{entry.handle}</span><small>{kindName(entry.kind)}{entry.modalities?.includes('ocrText')?' · OCR':''}{entry.modalities?.includes('transcript')?' · ASR':''}</small></td><td className="wb-log-text">{entry.preview}</td><td><b>{entry.score}</b>{entry.category!=='none'&&<TrackTag category={entry.category}/>}</td><td><span className={`wb-decision-chip ${entry.decision}`}>{entry.decision==='queued'?L('аналитику','талдаушыға'):L('отсеяно','сүзілді')}</span></td></tr>)}</tbody></table>
   </section>
   <section className="wb-panel">
    <header><h3>{L('Откуда приходит контент','Мазмұн қайдан келеді')}</h3></header>
    <ul className="wb-sources">
     <li><Activity size={16}/><div><strong>{L('Синтетический поток','Синтетикалық ағын')}</strong><p>{L(`${data.corpus.accounts} вымышленных аккаунтов, связанные сети, эфиры, скриншоты и групповые чаты. Создан для демонстрации, не собран из соцсетей.`,`${data.corpus.accounts} ойдан шығарылған аккаунт, байланысқан желілер, эфирлер, скриншоттар мен топтық чаттар. Демонстрацияға арналған.`)}</p></div><span className="wb-badge ok">{L('подключён','қосулы')}</span></li>
     <li><Send size={16}/><div><strong>{L('Открытые каналы Telegram','Telegram ашық арналары')}</strong><p>{L('Сервер по расписанию читает выбранные публичные каналы; новые сообщения проходят тот же анализ.','Сервер кесте бойынша таңдалған ашық арналарды оқиды; жаңа хабарлар сол талдаудан өтеді.')}</p></div><button className="wb-link" onClick={()=>go('monitor')}>{L('Настроить','Баптау')}<ArrowRight size={13}/></button></li>
     <li><Instagram size={16}/><div><strong>{L('Расширение браузера','Браузер кеңейтімі')}</strong><p>{L('Проверяет видимые публикации Instagram/TikTok, кадры и речь эфиров у аналитика.','Талдаушыдағы Instagram/TikTok жарияланымдарын, кадрлар мен эфир сөзін тексереді.')}</p></div><button className="wb-link" onClick={()=>go('sources')}>{L('Подробно','Толығырақ')}<ArrowRight size={13}/></button></li>
     <li><Layers size={16}/><div><strong>{L('Пакетный API','Пакеттік API')}</strong><p><code>POST /api/screen</code> — {L('до 500 публикаций за запрос, без сохранения. Для подключения потоков платформ и ведомств.','бір сұрауда 500-ге дейін жарияланым, сақтаусыз. Платформа мен ведомство ағындарын қосу үшін.')}</p></div><span className="wb-badge ok">{L('готов','дайын')}</span></li>
    </ul>
    {data.streamQuality&&<p className="wb-note">{L(`По разметке демо-потока: найдено ${data.streamQuality.tp} из ${data.streamQuality.tp+data.streamQuality.fn} рисковых, ложных ${data.streamQuality.fp}. Поток использовался при настройке правил — это демонстрация, а не независимая оценка.`,`Демо-ағын белгілеуі бойынша: ${data.streamQuality.tp+data.streamQuality.fn} тәуекелдің ${data.streamQuality.tp} табылды, жалған ${data.streamQuality.fp}. Ағын ережелерді баптауда қолданылды — бұл тәуелсіз бағалау емес.`)}</p>}
   </section>
  </div>
 </div>;
}

// ——— Networks: accounts, channels and domains as one scheme.
function ClusterGraph({cluster}){
 const accounts=cluster.accounts.slice(0,9),shared=cluster.shared.slice(0,4);const width=300,height=190,cx=width/2,cy=height/2;
 const accountPos=accounts.map((_,i)=>{const angle=(i/accounts.length)*Math.PI*2-Math.PI/2;return [cx+Math.cos(angle)*120,cy+Math.sin(angle)*72];});
 const sharedPos=shared.map((_,i)=>[cx+(i-(shared.length-1)/2)*58,cy]);
 return <svg className="wb-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={L(`Сеть из ${cluster.size} аккаунтов`,`${cluster.size} аккаунттан тұратын желі`)}>
  {accountPos.map(([x,y],i)=>sharedPos.map(([sx,sy],j)=><line key={`${i}-${j}`} x1={x} y1={y} x2={sx} y2={sy}/>))}
  {sharedPos.map(([x,y],j)=><g key={j} className="wb-node shared"><rect x={x-26} y={y-11} width={52} height={22} rx={6}/><text x={x} y={y+4}>{shared[j].value.length>9?`${shared[j].value.slice(0,8)}…`:shared[j].value}</text></g>)}
  {accountPos.map(([x,y],i)=><g key={i} className={`wb-node account ${accounts[i].risky?'risky':''}`}><circle cx={x} cy={y} r={accounts[i].risky?8:6}/><title>{accounts[i].handle}</title></g>)}
 </svg>;
}
export function NetworksPage(){
 const [data]=usePoll('/api/networks',5000);
 if(!data)return <div className="wb"><p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Строим связи…','Байланыстар құрылуда…')}</p></div>;
 const networks=data.networks.filter(cluster=>cluster.size>1);const kk=getLanguage()==='kk';
 return <div className="wb wb-networks">
  <p className="wb-principle"><Info size={15}/>{kk?data.disclaimer.kk:data.disclaimer.ru}</p>
  {networks.length===0?<p className="wb-empty">{L('Связанных сетей пока нет: поток ещё не обработан или аккаунты не пересекаются.','Байланысқан желі әзірге жоқ.')}</p>:
  <div className="wb-cluster-grid">{networks.map(cluster=><article key={cluster.id} className={`wb-cluster ${cluster.category}`}>
   <header><TrackTag category={cluster.category}/><span>{L(`${cluster.size} аккаунтов · ${cluster.riskyItems} помеченных материалов`,`${cluster.size} аккаунт · ${cluster.riskyItems} белгіленген материал`)}</span></header>
   <ClusterGraph cluster={cluster}/>
   <h4>{L('Что их связывает','Оларды не байланыстырады')}</h4>
   <div className="wb-chips">{cluster.shared.slice(0,6).map(shared=><span key={shared.type+shared.value} className="wb-chip"><small>{kk?shared.label.kk:shared.label.ru}</small>{shared.value}<em>×{shared.accounts}</em></span>)}</div>
   <ul className="wb-accounts">{cluster.accounts.slice(0,8).map(account=><li key={account.key}><PlatformIcon platform={account.platform} size={12}/>{account.handle}<small>{account.followers?`${number(account.followers)} · `:''}{L(`помечено ${account.risky} из ${account.items}`,`${account.items} ішінен ${account.risky} белгіленді`)}</small></li>)}</ul>
  </article>)}</div>}
  <section className="wb-panel">
   <header><h3>{L('Аккаунты и группы с повторяющимися признаками','Белгілері қайталанатын аккаунттар мен топтар')}</h3></header>
   <table className="wb-log"><thead><tr><th>{L('Аккаунт','Аккаунт')}</th><th>{L('Помечено','Белгіленді')}</th><th>{L('Макс. риск','Макс. тәуекел')}</th><th>{L('Сеть','Желі')}</th></tr></thead><tbody>{data.accounts.slice(0,20).map(account=><tr key={account.key}><td><PlatformIcon platform={account.platform} size={12}/><span className="wb-log-handle">{account.handle}</span>{account.kind==='group'&&<small>{L('группа','топ')}</small>}</td><td>{account.risky} / {account.items}</td><td><b>{account.maxScore}</b></td><td>{account.networkSize>1?L(`${account.networkSize} акк.`,`${account.networkSize} акк.`):'—'}</td></tr>)}</tbody></table>
  </section>
 </div>;
}

// ——— Quality: honest numbers on data neither the rules nor the model saw.
function Bars({rows}){return <ul className="wb-bars">{rows.map(row=><li key={row.label}><span>{row.label}</span><div className="wb-bar-pair">{row.values.map(value=><div key={value.name} className="wb-bar-row" title={`${value.name}: ${percent(value.value)}`}><i className={value.className} style={{width:`${(value.value??0)*100}%`}}/><b>{percent(value.value)}</b></div>)}</div></li>)}</ul>;}
function CurveChart({curve,threshold}){
 const width=520,height=220,pad={l:40,r:16,t:14,b:30};const xs=curve.map(point=>point.threshold);const minX=Math.min(...xs),maxX=Math.max(...xs);
 const x=value=>pad.l+((value-minX)/(maxX-minX||1))*(width-pad.l-pad.r);const y=value=>pad.t+(1-value)*(height-pad.t-pad.b);
 const series=[['precision','Precision','p'],['recall','Recall','r'],['falsePositiveRate',L('Ложные','Жалған'),'f']];
 const [hover,setHover]=useState(null);
 return <figure className="wb-curve"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={L('Precision, recall и доля ложных срабатываний в зависимости от порога','Шекке байланысты precision, recall және жалған белгілер үлесі')} onMouseLeave={()=>setHover(null)}>
  {[0,0.25,0.5,0.75,1].map(tick=><g key={tick} className="wb-grid"><line x1={pad.l} x2={width-pad.r} y1={y(tick)} y2={y(tick)}/><text x={pad.l-6} y={y(tick)+4}>{tick*100}%</text></g>)}
  {xs.map(value=><text key={value} className="wb-axis" x={x(value)} y={height-10}>{value}</text>)}
  <line className="wb-threshold" x1={x(threshold)} x2={x(threshold)} y1={pad.t} y2={height-pad.b}/>
  {series.map(([key,,cls])=><polyline key={key} className={`wb-line ${cls}`} points={curve.map(point=>`${x(point.threshold)},${y(point[key]??0)}`).join(' ')}/>)}
  {series.map(([key,label,cls])=>{const last=curve.at(-1);return <text key={key} className={`wb-direct ${cls}`} x={x(last.threshold)-4} y={y(last[key]??0)-6}>{label}</text>;})}
  {curve.map((point,i)=><rect key={i} className="wb-hit" x={x(point.threshold)-18} y={pad.t} width={36} height={height-pad.t-pad.b} onMouseEnter={()=>setHover(point)}/>)}
  {hover&&<g className="wb-tip"><line x1={x(hover.threshold)} x2={x(hover.threshold)} y1={pad.t} y2={height-pad.b}/>{series.map(([key,,cls])=><circle key={key} className={cls} cx={x(hover.threshold)} cy={y(hover[key]??0)} r={4.5}/>)}</g>}
 </svg>
 <figcaption>{hover?L(`Порог ${hover.threshold}: precision ${percent(hover.precision)}, recall ${percent(hover.recall)}, ложные ${percent(hover.falsePositiveRate)}`,`Шек ${hover.threshold}: precision ${percent(hover.precision)}, recall ${percent(hover.recall)}, жалған ${percent(hover.falsePositiveRate)}`):L(`Вертикальная линия — рабочий порог ${threshold}. Наведите на график, чтобы увидеть значения.`,`Тік сызық — жұмыс шегі ${threshold}. Мәндерді көру үшін графикке апарыңыз.`)}</figcaption></figure>;
}
export function QualityPage(){
 const [metrics]=usePoll('/api/metrics',0);
 const [review]=usePoll('/api/review-stats',10000);
 if(!metrics)return <div className="wb"><p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Загрузка метрик…','Метрикалар жүктелуде…')}</p></div>;
 const test=metrics.test;if(!test)return <div className="wb"><p className="wb-empty">{L('Нет тестовой выборки. Запустите npm run evaluate.','Тест іріктемесі жоқ.')}</p></div>;
 const holdout=test.splits.holdout,rules=metrics.rulesOnly?.test?.splits?.holdout,first=metrics.blindFirstRun;
 const regimes=[
  first&&{name:L('Первый слепой прогон: правила до просмотра выборки','Алғашқы соқыр өту: ережелер'),m:first},
  rules&&{name:L('Правила после разбора ошибок validation','Validation қателерінен кейінгі ережелер'),m:rules},
  {name:L('Правила + модель — рабочий режим','Ережелер + модель — жұмыс режимі'),m:holdout,main:true},
 ].filter(Boolean);
 const hb=test.holdoutBreakdown??test;const pc=hb.perCategory;const lang=Object.entries(hb.byLanguage);const hard=Object.entries(hb.hardNegatives);
 const hardName={free_giveaway:['Бесплатные конкурсы','Тегін байқаулар'],legal_ad:['Легальная реклама','Заңды жарнама'],news_warning:['Новости и предупреждения','Жаңалық пен ескерту'],charity:['Благотворительность','Қайырымдылық'],gaming_stream:['Игровые стримы','Ойын стримдері'],ordinary:['Обычные посты','Кәдімгі жазбалар'],education:['Обучение','Оқыту'],job:['Вакансии','Бос орындар'],product_draw:['Розыгрыш среди покупателей','Сатып алушылар арасындағы ұтыс']};
 return <div className="wb wb-quality">
  <section className="wb-panel">
   <header><h3>{L('Три режима на одних и тех же отложенных данных','Бірдей кейінге қалдырылған деректердегі үш режим')}</h3></header>
   <table className="wb-table"><thead><tr><th>{L('Режим','Режим')}</th><th>Precision</th><th>Recall</th><th>F1</th><th>{L('Ложные срабатывания','Жалған белгілер')}</th></tr></thead><tbody>{regimes.map(row=><tr key={row.name} className={row.main?'main':''}><td>{row.name}</td><td>{percent(row.m.precision)}</td><td>{percent(row.m.recall)}</td><td>{percent(row.m.f1)}</td><td>{percent(row.m.falsePositiveRate)}</td></tr>)}</tbody></table>
   <p className="wb-note">{L(`Тестовую выборку (${test.total} синтетических примеров на RU/KK/транслите) написал отдельный агент по тексту задания, не видя правил. Половина «validation» использовалась для разбора ошибок, половина «holdout» (${holdout.total}) — только для итоговых цифр. Первый прогон посчитан на всей выборке до любых правок. Синтетика не равна реальному потоку соцсетей.`,`Тест іріктемесін (${test.total} синтетикалық мысал) ережелерді көрмеген бөлек агент жазды. «Validation» жартысы қателерді талдауға, «holdout» жартысы (${holdout.total}) тек қорытынды сандарға қолданылды.`)}</p>
  </section>
  <div className="wb-split">
   <section className="wb-panel"><header><h3>{L('По трекам (holdout)','Тректер бойынша (holdout)')}</h3><span className="wb-legend"><i className="p"/>Precision <i className="r"/>Recall</span></header>
    <Bars rows={['lottery','casino','pyramid'].map(id=>({label:trackName(id),values:[{name:'Precision',value:pc[id]?.precision,className:'p'},{name:'Recall',value:pc[id]?.recall,className:'r'}]}))}/>
    <p className="wb-note">{L('Только отложенная часть (holdout): около 26 примеров на трек, поэтому разброс велик. Слабое место — пирамиды в разговорной форме.','Тек holdout бөлігі: тректе шамамен 26 мысал. Әлсіз жері — ауызекі пирамидалар.')}</p></section>
   <section className="wb-panel"><header><h3>{L('По языку (holdout)','Тіл бойынша (holdout)')}</h3><span className="wb-legend"><i className="p"/>Precision <i className="r"/>Recall</span></header>
    <Bars rows={lang.map(([id,value])=>({label:{ru:L('Русский','Орысша'),kk:L('Казахский','Қазақша'),mixed:L('Смешанный','Аралас'),translit:L('Транслит','Транслит')}[id]??id,values:[{name:'Precision',value:value.precision,className:'p'},{name:'Recall',value:value.recall,className:'r'}]}))}/></section>
  </div>
  <div className="wb-split">
   <section className="wb-panel"><header><h3>{L('Трудные негативы на holdout: сколько попало в очередь','Holdout қиын негативтері: кезекке қаншасы түсті')}</h3></header>
    <ul className="wb-bars single">{hard.map(([id,value])=><li key={id}><span>{L(...(hardName[id]??[id,id]))}</span><div className="wb-bar-row"><i className="f" style={{width:`${Math.max(value.falsePositiveRate*100,value.falsePositives?2:0)}%`}}/><b>{value.falsePositives} / {value.total}</b></div></li>)}</ul>
    <p className="wb-note">{L('Обычные розыгрыши, легальная реклама и новости — главный источник ложных тревог по условиям задания.','Кәдімгі ұтыстар, заңды жарнама және жаңалықтар — жалған дабылдың басты көзі.')}</p></section>
   <section className="wb-panel"><header><h3>{L('Порог отправки в очередь','Кезекке жіберу шегі')}</h3></header><CurveChart curve={hb.thresholdCurve} threshold={metrics.threshold}/></section>
  </div>
  <div className="wb-split">
   <section className="wb-panel"><header><h3>{L('Кто поднял случай и насколько ему верить','Жағдайды кім көтерді және оған қаншалық сенуге болады')}</h3></header>
    <dl className="wb-kpis"><div><dt>{L('Подтверждено правилами','Ережелер растады')}</dt><dd>{percent(test.bands?.rules?.holdoutPrecision)}</dd><small>{L(`точность на holdout, случаев: ${test.bands?.rules?.holdoutFlagged}`,`holdout дәлдігі, жағдай: ${test.bands?.rules?.holdoutFlagged}`)}</small></div><div><dt>{L('Только модель','Тек модель')}</dt><dd>{percent(test.bands?.model?.holdoutPrecision)}</dd><small>{L(`точность на holdout, случаев: ${test.bands?.model?.holdoutFlagged}`,`holdout дәлдігі, жағдай: ${test.bands?.model?.holdoutFlagged}`)}</small></div></dl>
    <p className="wb-note">{L('Случаи «только модель» отмечены в очереди и стоят ниже по приоритету: аналитик видит, что правила нашли мало признаков.','«Тек модель» жағдайлары кезекте белгіленген және басымдығы төмен.')}</p></section>
   <section className="wb-panel"><header><h3>{L('Скорость и масштаб','Жылдамдық пен ауқым')}</h3></header>
    <dl className="wb-kpis"><div><dt>{L('Публикаций в секунду','Секундына жарияланым')}</dt><dd>{number(metrics.benchmark?.itemsPerSecond)}</dd><small>{L('одно ядро, без OCR/ASR','бір ядро, OCR/ASR-сыз')}</small></div><div><dt>{L('На публикацию','Бір жарияланымға')}</dt><dd>{metrics.benchmark?.msPerItem} {L('мс','мс')}</dd><small>{L('правила + модель','ережелер + модель')}</small></div></dl>
    <p className="wb-note">{L(`≈ ${number(Math.round((metrics.benchmark?.itemsPerSecond??0)*86400/1e6))} млн текстов в сутки на одно ядро. Анализ не хранит состояния и масштабируется добавлением воркеров за очередью сообщений.`,`Бір ядроға тәулігіне ≈ ${number(Math.round((metrics.benchmark?.itemsPerSecond??0)*86400/1e6))} млн мәтін. Талдау күйсіз және воркерлер қосу арқылы масштабталады.`)}</p></section>
  </div>
  {review?.total>0&&<section className="wb-panel"><header><h3>{L('Обратная связь аналитиков','Талдаушылардың кері байланысы')}</h3><span className="wb-note">{L(`решений: ${review.total}, подтверждено ${percent(review.confirmRate)}`,`шешім: ${review.total}, расталды ${percent(review.confirmRate)}`)}</span></header>
   <table className="wb-table"><thead><tr><th>{L('Признак','Белгі')}</th><th>{L('Подтверждено','Расталды')}</th><th>{L('Ложное','Жалған')}</th><th>{L('Доля подтверждений','Растау үлесі')}</th></tr></thead><tbody>{review.signals.slice(0,10).map(row=><tr key={row.id}><td><code>{row.id}</code></td><td>{row.confirmed}</td><td>{row.dismissed}</td><td>{percent(row.confirmRate)}</td></tr>)}</tbody></table>
   <p className="wb-note">{L('Признаки, которые аналитики часто отклоняют, — кандидаты на снижение веса в следующей версии правил и на дообучение модели.','Талдаушылар жиі қабылдамайтын белгілер — келесі нұсқада салмағын азайту үміткерлері.')}</p></section>}
 </div>;
}

// ——— Discovery: real public Telegram channels found automatically from seed channels.
const OUTCOME={risky:['признаки найдены','белгілер табылды'],clean:['признаков нет','белгі жоқ'],unavailable:['нет публичного предпросмотра','ашық алдын ала қарау жоқ'],error:['ошибка запроса','сұрау қатесі']};
const VIA={seed:['стартовый канал','бастапқы арна'],link:['ссылка','сілтеме'],forward:['пересылка','қайта жіберу'],mention:['упоминание','атау'],instagram_link:['ссылка из Instagram','Instagram сілтемесі'],tiktok_link:['ссылка из TikTok','TikTok сілтемесі']};
export function DiscoveryPage({onOpen}){
 const [data,reload]=usePoll('/api/discovery',4000);
 const [input,setInput]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const act=async(path,options)=>{setBusy(true);setError('');try{await api(path,options);await reload();return true;}catch(e){setError(e.message);return false;}finally{setBusy(false);}};
 const openSample=async url=>{try{const queue=await api('/api/queue');const found=[...queue.open,...queue.reviewed].find(item=>item.url===url);if(found)onOpen(found.id);}catch(e){setError(e.message);}};
 if(!data)return <div className="wb"><p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Подключение к автопоиску…','Автоіздеуге қосылу…')}</p></div>;
 const kk=getLanguage()==='kk';const limited=data.stats.rateLimitedUntil&&Date.parse(data.stats.rateLimitedUntil)>Date.now();
 const userSeeds=new Set(data.seeds.map(seed=>seed.handle));
 const dominant=channel=>Object.entries(channel.categories||{}).sort((a,b)=>b[1]-a[1])[0]?.[0]??'none';
 const via=channel=>channel.foundVia.length?channel.foundVia.slice(0,2).map(item=>item.from?`@${item.from.replace(/^(?:instagram|tiktok|telegram):/,'')} (${L(...(VIA[item.kind]??[item.kind,item.kind]))})`:L(...VIA.seed)).join(', '):L(...VIA.seed);
 return <div className="wb wb-discovery">
  <section className="wb-panel wb-pipe-head">
   <div><p className="wb-live">{limited?<><Clock3 size={15}/>{L('Telegram попросил паузу — продолжим через несколько минут','Telegram үзіліс сұрады — бірнеше минуттан кейін жалғасады')}</>:data.enabled?<><i className="wb-pulse"/>{L('Автопоиск работает: каналы проверяются каждые 20 секунд','Автоіздеу жұмыс істеп тұр: арналар әр 20 секунд сайын тексеріледі')}</>:<><Pause size={15}/>{L('Автопоиск на паузе','Автоіздеу кідіртілді')}</>}</p>
    <h2>{number(data.counts.risky)} <span>{L(`каналов с признаками схем из ${number(data.counts.channels)} найденных`,`табылған ${number(data.counts.channels)} арнаның белгілері барлары`)}</span></h2>
    <dl className="wb-kpis small"><div><dt>{L('Постов с признаками','Белгілері бар жазбалар')}</dt><dd>{number(data.stats.flaggedPosts)}</dd></div><div><dt>{L('Отправлено аналитику','Талдаушыға жіберілді')}</dt><dd>{number(data.stats.savedCases)}</dd></div><div><dt>{L('Ждут проверки','Тексеруді күтуде')}</dt><dd>{number(data.counts.queued)}</dd></div><div><dt>{L('Запросов к Telegram','Telegram сұраулары')}</dt><dd>{number(data.stats.probes)}</dd></div></dl>
   </div>
   <div className="wb-pipe-controls">
    {data.enabled?<button className="wb-button" disabled={busy} onClick={()=>act('/api/discovery',{method:'PUT',body:JSON.stringify({enabled:false})})}><Pause size={16}/>{L('Пауза','Кідірту')}</button>:<button className="wb-button primary" disabled={busy} onClick={()=>act('/api/discovery',{method:'PUT',body:JSON.stringify({enabled:true})})}><Play size={16}/>{L('Включить поиск','Іздеуді қосу')}</button>}
    <button className="wb-button ghost" disabled={busy||!data.enabled} onClick={()=>act('/api/discovery/run',{method:'POST',body:'{}'})}><Search size={16}/>{L('Проверить сейчас','Қазір тексеру')}</button>
   </div>
  </section>
  <section className="wb-panel">
   <header><h3>{L('Откуда начинать поиск','Іздеуді қайдан бастау')}</h3></header>
   <form className="wb-seed-form" onSubmit={async event=>{event.preventDefault();if(input.trim()&&await act('/api/discovery/seeds',{method:'POST',body:JSON.stringify({channel:input.trim()})}))setInput('');}}>
    <input value={input} onChange={e=>setInput(e.target.value)} placeholder={L('@канал или https://t.me/канал — подозрительный или из новостей','@арна не https://t.me/арна — күдікті не жаңалықтан')} aria-label={L('Публичный Telegram-канал','Ашық Telegram арнасы')}/>
    <button className="wb-button primary" disabled={busy||!input.trim()}><Plus size={16}/>{L('Добавить','Қосу')}</button>
   </form>
   {error&&<p className="wb-error" role="alert"><AlertTriangle size={14}/>{error}</p>}
   <div className="wb-chips">{data.configuredSeeds.map(handle=><span key={handle} className="wb-chip"><Send size={12}/>@{handle}{userSeeds.has(handle)?<button className="wb-chip-x" aria-label={L(`Убрать @${handle}`,`@${handle} алып тастау`)} onClick={()=>act(`/api/discovery/seeds/${handle}`,{method:'DELETE'})}><Trash2 size={12}/></button>:<small>{L('мониторинг','мониторинг')}</small>}</span>)}</div>
   <p className="wb-note">{L('Система читает стартовые каналы и идёт по ссылкам, пересылкам и @упоминаниям. Дальше поиск расширяется только от каналов, где нашлись признаки схем: он следует за схемой, а не обходит весь Telegram.','Жүйе бастапқы арналарды оқып, сілтемелер, қайта жіберулер мен @атаулар бойынша жүреді. Әрі қарай тек схема белгілері табылған арналардан кеңейеді.')}</p>
  </section>
  <section className="wb-panel">
   <header><h3>{L('Найденные каналы с признаками схем','Схема белгілері бар табылған арналар')}</h3><span className="wb-note">{L('настоящие публичные каналы','нақты ашық арналар')}</span></header>
   {data.risky.length?<ul className="wb-found">{data.risky.map(channel=><li key={channel.handle}>
    <div className="wb-found-head"><ScoreDial score={channel.maxScore} level={channel.maxScore>=60?'high':'medium'} size={44}/><div><strong>{channel.title}</strong><a href={`https://t.me/s/${channel.handle}`} target="_blank" rel="noopener noreferrer">@{channel.handle}<ExternalLink size={12}/></a></div><TrackTag category={dominant(channel)}/></div>
    <p className="wb-found-meta">{L(`постов с признаками: ${channel.flaggedPosts}`,`белгілері бар жазбалар: ${channel.flaggedPosts}`)} · {L('найден через','табылды')}: {via(channel)} · {L('уровень','деңгей')} {channel.depth} · {ago(channel.lastCheckedAt)}{channel.invites?.length?` · ${L(`закрытых приглашений: ${channel.invites.length}`,`жабық шақырулар: ${channel.invites.length}`)}`:''}</p>
    {channel.sample&&<blockquote className="wb-found-sample">{channel.sample.text}</blockquote>}
    {channel.sample&&<button className="wb-link" onClick={()=>openSample(channel.sample.url)}>{L('Открыть в очереди проверки','Тексеру кезегінде ашу')}<ArrowRight size={13}/></button>}
   </li>)}</ul>:<p className="wb-empty">{L('Пока не найдено. Добавьте стартовые каналы — например, подозрительный канал из жалобы или новости. Дальше поиск пойдёт сам.','Әзірге табылмады. Бастапқы арналарды қосыңыз — іздеу өзі жалғасады.')}</p>}
  </section>
  <div className="wb-split">
   <section className="wb-panel"><header><h3>{L('Очередь кандидатов','Үміткерлер кезегі')}</h3><span className="wb-note">{number(data.counts.queued)}</span></header>
    {data.queued.length?<ul className="wb-accounts">{data.queued.map(channel=><li key={channel.handle}><Send size={12}/>@{channel.handle}<small>{channel.foundVia[0]?.from?`← @${channel.foundVia[0].from}`:L('старт','бастау')} · {L('ур.','д.')} {channel.depth}</small></li>)}</ul>:<p className="wb-note">{L('Очередь пуста.','Кезек бос.')}</p>}</section>
   <section className="wb-panel"><header><h3>{L('Журнал проверок','Тексеру журналы')}</h3></header>
    {data.log.length?<table className="wb-log"><tbody>{data.log.slice(0,14).map((entry,i)=><tr key={i} className={entry.outcome==='risky'?'queued':''}><td><span className="wb-log-handle">@{entry.handle}</span><small>{ago(entry.at)}</small></td><td>{L(...(OUTCOME[entry.outcome]??[entry.outcome,entry.outcome]))}{entry.flagged?` · ${entry.flagged}`:''}{entry.discovered?` · +${entry.discovered} ${L('новых','жаңа')}`:''}</td></tr>)}</tbody></table>:<p className="wb-note">{L('Проверок ещё не было.','Тексеру әлі болған жоқ.')}</p>}</section>
  </div>
  <section className="wb-panel">
   <header><h3><Instagram size={15}/> Instagram · <Music2 size={15}/> TikTok</h3></header>
    <p className="wb-note wb-flush">{L('Аккаунты Instagram и TikTok, на которые ссылаются каналы с признаками схем, автоматически уходят в «Поиск в Instagram и TikTok». Telegram-ссылки из этих профилей возвращаются сюда.','Схема белгілері бар арналар сілтеме жасайтын Instagram мен TikTok аккаунттары «Instagram мен TikTok-та іздеу» бөліміне автоматты түрде жіберіледі. Сол профильдердегі Telegram сілтемелері осында қайтады.')}</p>
  </section>
  <p className="wb-principle"><Info size={15}/>{kk?data.notes.kk:data.notes.ru}</p>
 </div>;
}

const SOCIAL_OUTCOME={risky:['признаки найдены','белгілер табылды'],clean:['признаков нет','белгі жоқ'],unavailable:['аккаунт не найден','аккаунт табылмады'],private:['закрытый аккаунт','жабық аккаунт'],blocked:['платформа попросила паузу','платформа үзіліс сұрады'],error:['ошибка браузера','браузер қатесі'],search:['поисковый запрос','іздеу сұрауы']};
const SOCIAL_VIA={seed:['стартовый аккаунт','бастапқы аккаунт'],search:['поисковая выдача','іздеу нәтижесі'],mention:['упоминание','атау'],link:['ссылка в профиле','профильдегі сілтеме'],telegram_link:['ссылка из Telegram','Telegram сілтемесі'],extension:['расширение аналитика','талдаушы кеңейтімі']};
const PLATFORM_NAME={instagram:'Instagram',tiktok:'TikTok'};
const socialUrl=account=>account.platform==='tiktok'?`https://www.tiktok.com/@${account.handle}`:`https://www.instagram.com/${account.handle}/`;
const clock=iso=>new Date(iso).toLocaleTimeString(getLanguage()==='kk'?'kk-KZ':'ru-RU',{hour:'2-digit',minute:'2-digit'});
export function SocialPage({onOpen}){
  const [data,reload]=usePoll('/api/social',5000);
  const [input,setInput]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const act=async(path,options)=>{setBusy(true);setError('');try{await api(path,options);await reload();return true;}catch(e){setError(e.message);return false;}finally{setBusy(false);}};
  const openSample=async url=>{try{const queue=await api('/api/queue');const found=[...queue.open,...queue.reviewed].find(item=>item.url===url);if(found)onOpen(found.id);}catch(e){setError(e.message);}};
  if(!data)return <div className="wb"><p className="wb-empty"><LoaderCircle className="wb-spin" size={16}/>{L('Подключение к поиску в соцсетях…','Әлеуметтік желілердегі іздеуге қосылу…')}</p></div>;
  const kk=getLanguage()==='kk';
  const paused=platform=>{const scope=data.platforms[platform];return scope?.blockedUntil&&Date.parse(scope.blockedUntil)>Date.now()?scope:null;};
  const searchPaused=data.search.blockedUntil&&Date.parse(data.search.blockedUntil)>Date.now();
  const dominant=account=>Object.entries(account.categories||{}).sort((a,b)=>b[1]-a[1])[0]?.[0]??'none';
  const via=account=>account.foundVia.length?account.foundVia.slice(0,2).map(item=>{const how=L(...(SOCIAL_VIA[item.kind]??[item.kind,item.kind]));return item.from?`${item.from.replace(/^(instagram|tiktok|telegram):/,'@')} (${how})`:how;}).join(', '):L(...SOCIAL_VIA.seed);
  const seedKeys=new Set(data.seeds.map(seed=>`${seed.platform}:${seed.handle}`));
  return <div className="wb wb-discovery">
   <section className="wb-panel wb-pipe-head">
    <div><p className="wb-live">{data.enabled?<><i className="wb-pulse"/>{L(`Автопоиск работает: один профиль раз в ${data.limits.tickMs/1000} с, без входа в аккаунт`,`Автоіздеу жұмыс істейді: ${data.limits.tickMs/1000} с сайын бір профиль, аккаунтқа кірмей`)}</>:<><Pause size={15}/>{L('Поиск на паузе','Іздеу кідіртілді')}</>}</p>
     <h2>{number(data.counts.risky)} <span>{L(`аккаунтов с признаками схем из ${number(data.counts.accounts)} найденных`,`табылған ${number(data.counts.accounts)} аккаунттың белгілері барлары`)}</span></h2>
     <dl className="wb-kpis small">{['instagram','tiktok'].map(platform=><div key={platform}><dt>{PLATFORM_NAME[platform]}</dt><dd>{number(data.counts.byPlatform[platform].risky)} <small>/ {number(data.counts.byPlatform[platform].accounts)}</small></dd></div>)}<div><dt>{L('Отправлено аналитику','Талдаушыға жіберілді')}</dt><dd>{number(data.stats.savedCases)}</dd></div><div><dt>{L('Открыто профилей','Ашылған профильдер')}</dt><dd>{number(data.stats.probes)}</dd></div></dl>
    </div>
    <div className="wb-pipe-controls">
     {data.enabled?<button className="wb-button" disabled={busy} onClick={()=>act('/api/social',{method:'PUT',body:JSON.stringify({enabled:false})})}><Pause size={16}/>{L('Пауза','Кідірту')}</button>:<button className="wb-button primary" disabled={busy} onClick={()=>act('/api/social',{method:'PUT',body:JSON.stringify({enabled:true})})}><Play size={16}/>{L('Включить поиск','Іздеуді қосу')}</button>}
     <button className="wb-button ghost" disabled={busy||!data.enabled} onClick={()=>act('/api/social/run',{method:'POST',body:'{}'})}>{busy?<LoaderCircle className="wb-spin" size={16}/>:<Search size={16}/>}{L('Проверить сейчас','Қазір тексеру')}</button>
    </div>
   </section>
   <section className="wb-panel">
    <header><h3>{L('Состояние источников','Дереккөздер күйі')}</h3></header>
    <div className="wb-chips">
     {['instagram','tiktok'].map(platform=>{const scope=paused(platform);return <span key={platform} className="wb-chip"><PlatformIcon platform={platform} size={12}/>{PLATFORM_NAME[platform]}<small>{scope?L(`пауза до ${clock(scope.blockedUntil)}: ${scope.reason==='login_wall'?'просит вход':'капча'}`,`${clock(scope.blockedUntil)} дейін кідіріс: ${scope.reason==='login_wall'?'кіруді сұрайды':'капча'}`):L('открывается','ашылады')}</small></span>;})}
     <span className="wb-chip"><Search size={12}/>{L('Поисковая выдача','Іздеу нәтижесі')}<small>{searchPaused?L(`пауза до ${clock(data.search.blockedUntil)}`,`${clock(data.search.blockedUntil)} дейін кідіріс`):data.search.nextAt?L(`следующий запрос в ${clock(data.search.nextAt)}`,`келесі сұрау ${clock(data.search.nextAt)}`):L('скоро','жақында')}</small></span>
    </div>
    <p className="wb-note wb-terms"><AlertTriangle size={14}/><span>{L('Правила Meta и TikTok запрещают автоматический сбор данных. Режим включён оператором осознанно: открываются только публичные страницы, вход в аккаунт не используется, капчи не обходятся — при капче или требовании входа платформа ставится на паузу.','Meta мен TikTok ережелері деректерді автоматты жинауға тыйым салады. Режимді оператор саналы түрде қосқан: тек ашық беттер ашылады, аккаунтқа кірмейді, капча айналып өтілмейді — капча не кіру талабы шықса, платформа кідіртіледі.')}</span></p>
   </section>
   <section className="wb-panel">
    <header><h3>{L('Откуда начинать поиск','Іздеуді қайдан бастау')}</h3></header>
    <form className="wb-seed-form" onSubmit={async event=>{event.preventDefault();if(input.trim()&&await act('/api/social/seeds',{method:'POST',body:JSON.stringify({account:input.trim()})}))setInput('');}}>
     <input value={input} onChange={e=>setInput(e.target.value)} placeholder={L('tiktok.com/@имя или instagram.com/имя — подозрительный аккаунт из жалобы или выдачи','tiktok.com/@атау не instagram.com/атау — шағымнан не іздеуден күдікті аккаунт')} aria-label={L('Профиль Instagram или TikTok','Instagram не TikTok профилі')}/>
     <button className="wb-button primary" disabled={busy||!input.trim()}><Plus size={16}/>{L('Добавить','Қосу')}</button>
    </form>
    {error&&<p className="wb-error" role="alert"><AlertTriangle size={14}/>{error}</p>}
    {data.seeds.length>0&&<div className="wb-chips">{data.seeds.map(seed=><span key={`${seed.platform}:${seed.handle}`} className="wb-chip"><PlatformIcon platform={seed.platform} size={12}/>@{seed.handle}<button className="wb-chip-x" aria-label={L(`Убрать @${seed.handle}`,`@${seed.handle} алып тастау`)} onClick={()=>act(`/api/social/seeds/${seed.platform}/${seed.handle}`,{method:'DELETE'})}><Trash2 size={12}/></button></span>)}</div>}
    <p className="wb-note">{L(`Кроме стартовых аккаунтов система берёт кандидатов из поисковой выдачи (${data.search.queries} запросов на русском и казахском, один раз в ${data.limits.searchEveryMinutes} минут), из ссылок в Telegram-каналах с признаками схем и из постов, которые аналитик видел через расширение. Дальше она идёт по @упоминаниям и ссылкам только от аккаунтов с признаками.`,`Бастапқы аккаунттардан бөлек, жүйе үміткерлерді іздеу нәтижесінен (${data.search.queries} сұрау, ${data.limits.searchEveryMinutes} минут сайын біреу), белгілері бар Telegram арналарындағы сілтемелерден және талдаушы кеңейтім арқылы көрген жазбалардан алады. Әрі қарай тек белгілері бар аккаунттардан @атаулар мен сілтемелер бойынша жүреді.`)}</p>
   </section>
   <section className="wb-panel">
    <header><h3>{L('Найденные аккаунты с признаками схем','Схема белгілері бар табылған аккаунттар')}</h3><span className="wb-note">{L('настоящие публичные аккаунты','нақты ашық аккаунттар')}</span></header>
    {data.risky.length?<ul className="wb-found">{data.risky.map(account=><li key={account.key}>
     <div className="wb-found-head"><ScoreDial score={account.maxScore} level={account.maxScore>=60?'high':'medium'} size={44}/><div><strong><PlatformIcon platform={account.platform} size={12}/> {account.name||`@${account.handle}`}</strong><a href={socialUrl(account)} target="_blank" rel="noopener noreferrer">@{account.handle}<ExternalLink size={12}/></a></div><TrackTag category={dominant(account)}/></div>
     <p className="wb-found-meta">{L(`материалов с признаками: ${account.flaggedPosts}`,`белгілері бар материалдар: ${account.flaggedPosts}`)} · {L('найден через','табылды')}: {via(account)} · {ago(account.lastCheckedAt)}{account.domains?.length?` · ${L('сайты','сайттар')}: ${account.domains.slice(0,3).join(', ')}`:''}{account.telegram?.length?` · Telegram: ${account.telegram.slice(0,3).map(handle=>'@'+handle).join(', ')}`:''}</p>
     {account.sample&&<blockquote className="wb-found-sample">{account.sample.text}</blockquote>}
     {account.sample&&<button className="wb-link" onClick={()=>openSample(account.sample.url)}>{L('Открыть в очереди проверки','Тексеру кезегінде ашу')}<ArrowRight size={13}/></button>}
    </li>)}</ul>:<p className="wb-empty">{L('Пока не найдено. Добавьте подозрительный профиль или подождите поисковую выдачу — дальше поиск пойдёт сам.','Әзірге табылмады. Күдікті профильді қосыңыз немесе іздеу нәтижесін күтіңіз — әрі қарай іздеу өзі жүреді.')}</p>}
   </section>
   <div className="wb-split">
    <section className="wb-panel"><header><h3>{L('Очередь кандидатов','Үміткерлер кезегі')}</h3><span className="wb-note">{number(data.counts.queued)}</span></header>
     {data.queued.length?<ul className="wb-accounts">{data.queued.map(account=><li key={account.key}><PlatformIcon platform={account.platform} size={12}/>@{account.handle}{seedKeys.has(account.key)?<small>{L('старт','бастау')}</small>:<small>{via(account)}{account.hint?.risky?` · ${L('признаки в выдаче','нәтижеде белгі бар')}`:''}</small>}</li>)}</ul>:<p className="wb-note">{L('Очередь пуста.','Кезек бос.')}</p>}</section>
    <section className="wb-panel"><header><h3>{L('Журнал проверок','Тексеру журналы')}</h3></header>
     {data.log.length?<table className="wb-log"><tbody>{data.log.slice(0,14).map((entry,i)=><tr key={i} className={entry.outcome==='risky'?'queued':''}><td><span className="wb-log-handle">{entry.key==='search'?L('поиск','іздеу'):'@'+entry.key.split(':')[1]}</span><small>{ago(entry.at)}</small></td><td>{L(...(SOCIAL_OUTCOME[entry.outcome]??[entry.outcome,entry.outcome]))}{entry.flagged?` · ${entry.flagged}`:''}{entry.hits!==undefined?` · ${entry.hits} ${L('результатов','нәтиже')}`:''}{entry.discovered?` · +${entry.discovered}`:''}{entry.partial?` · ${L('частично, капча','ішінара, капча')}`:''}</td></tr>)}</tbody></table>:<p className="wb-note">{L('Проверок пока не было.','Әзірге тексеру болған жоқ.')}</p>}</section>
   </div>
   <p className="wb-principle"><Info size={15}/>{kk?data.notes.kk:data.notes.ru}</p>
  </div>;
}

