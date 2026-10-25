import {SESSION_DATA_EVENT} from './access-session.js';
import React, {useEffect, useState} from 'react';
import {ArrowRight, Info, Inbox, Radio, RefreshCw} from 'lucide-react';
import {getLanguage} from './i18n.js';

const L=(ru,kk)=>getLanguage()==='kk'?kk:ru;
const number=value=>value==null?'—':new Intl.NumberFormat(getLanguage()==='kk'?'kk-KZ':'ru-RU').format(value);
const time=value=>value?new Date(value).toLocaleString(getLanguage()==='kk'?'kk-KZ':'ru-RU'):'—';
export const isRealCase=item=>!item.demo&&!['pipeline','demo'].includes(item.source)&&item.provenance?.type!=='synthetic';
export const isSearchExcerpt=item=>item.kind==='search_snippet'||item.provenance?.method==='search_index';

export function SearchExcerptNote({item}){
 if(!isSearchExcerpt(item))return null;
 return <p className="wb-note"><Info size={14}/>{L('Фрагмент поисковой выдачи. Признаки найдены в тексте поисковика; чтение самого профиля или публикации не подтверждено.','Іздеу нәтижесінің үзіндісі. Белгілер іздеу жүйесінің мәтінінен табылды; профильдің не жарияланымның өзі оқылғаны расталмаған.')}</p>;
}

function useSnapshot(path){
 const [state,setState]=useState({data:null,error:'',receivedAt:null});
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true,inFlight=false;
  const controller=new AbortController();
  async function load(){
   if(inFlight)return;
   inFlight=true;
   try{
    const response=await fetch(path,{signal:controller.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const data=await response.json();
    if(active)setState({data,error:'',receivedAt:new Date().toISOString()});
   }catch(error){if(active)setState(old=>({...old,error:error.message}));}
   finally{inFlight=false;}
  }
  load();window.addEventListener(SESSION_DATA_EVENT,load);const timer=setInterval(load,6000);
  return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener(SESSION_DATA_EVENT,load);};
 },[path,revision]);
 return {...state,retry:()=>setRevision(value=>value+1)};
}

const paused=until=>Date.parse(until)>Date.now();
const pauseReason=reason=>reason==='login_wall'?L('требуется вход','кіру қажет'):reason==='captcha'?L('капча','капча'):L('ограничение платформы','платформа шектеуі');
export function socialPlatformStatus(data,platform){
 if(!data)return L('Состояние неизвестно','Күйі белгісіз');
 const scope=data.platforms?.[platform];
 if(paused(scope?.blockedUntil))return L(`Пауза до ${time(scope.blockedUntil)}: ${pauseReason(scope.reason)}`,`${time(scope.blockedUntil)} дейін кідіріс: ${pauseReason(scope.reason)}`);
 if(!data.enabled)return L('Поиск выключен','Іздеу өшірілген');
 const last=data.log?.find(entry=>entry.key?.startsWith(`${platform}:`));
 if(last?.partial)return L('Последняя проверка частичная: капча','Соңғы тексеру ішінара: капча');
 if(last?.outcome==='error')return L('Последняя попытка: ошибка браузера','Соңғы әрекет: браузер қатесі');
 if(last?.outcome==='blocked'||scope?.reason)return L(`Последний доступ ограничен: ${pauseReason(scope?.reason)}; успешная повторная проверка не подтверждена`,`Соңғы қолжетімділік шектелген: ${pauseReason(scope?.reason)}; сәтті қайта тексеру расталмаған`);
 if(last&&['risky','clean'].includes(last.outcome))return L(`Последняя проверка профиля: ${time(last.at)}; охват ограничен доступным текстом`,`Профильдің соңғы тексеруі: ${time(last.at)}; қамту қолжетімді мәтінмен шектелген`);
 if(last)return L('Последний профиль недоступен или закрыт','Соңғы профиль қолжетімсіз не жабық');
 return L('Поиск включён; успешное чтение профиля пока не подтверждено','Іздеу қосылған; профильдің сәтті оқылғаны әлі расталмаған');
}

function SnapshotNotice({snapshot}){
 if(snapshot.error)return <p className="wb-error" role="status">{L('Не удалось обновить данные.','Деректер жаңартылмады.')} {snapshot.error}{snapshot.receivedAt&&<> · {L('Последний ответ','Соңғы жауап')}: {time(snapshot.receivedAt)}</>} <button className="wb-link" onClick={snapshot.retry}><RefreshCw size={13}/>{L('Повторить','Қайталау')}</button></p>;
 if(!snapshot.data)return <p className="wb-note" role="status">{L('Загрузка состояния…','Күйі жүктелуде…')}</p>;
 return null;
}

function Counters({rows}){return <dl className="wb-kpis small">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{number(value)}</dd></div>)}</dl>;}

export default function LiveMonitoring({go,onOpen,overview=false}){
 const discovery=useSnapshot('/api/discovery'),social=useSnapshot('/api/social'),watchtower=useSnapshot('/api/watchtower'),queue=useSnapshot('/api/queue');
 const d=discovery.data,s=social.data,w=watchtower.data;
 const open=(queue.data?.open??[]).filter(isRealCase),reviewed=(queue.data?.reviewed??[]).filter(isRealCase);
 const sourceState=data=>!data?L('Состояние неизвестно','Күйі белгісіз'):!data.enabled?L('Выключен','Өшірілген'):data.busy||data.running?L('Идёт проверка','Тексерілуде'):L('Включён · ожидание следующей проверки','Қосылған · келесі тексеру күтілуде');
 const discoveryState=paused(d?.stats?.rateLimitedUntil)?L(`Пауза до ${time(d.stats.rateLimitedUntil)}`,`${time(d.stats.rateLimitedUntil)} дейін кідіріс`):sourceState(d);
 return <div className="wb wb-pipeline">
  <section className="wb-panel wb-pipe-head">
   <div><p className="wb-live"><Radio size={15}/>{L('Реальные публичные источники','Нақты ашық дереккөздер')}</p>
    <h2>{overview?L('Находки и очередь проверки','Табылған материалдар мен тексеру кезегі'):L('Состояние реального мониторинга','Нақты мониторинг күйі')}</h2>
    <p className="wb-note">{L('Telegram: проверенные стартовые каналы, затем поиск по ссылкам и упоминаниям от каналов с признаками. Охват ограничен доступными публичными страницами.','Telegram: тексерілген бастапқы арналар, кейін белгілері бар арналардың сілтемелері мен атаулары бойынша іздеу. Қамту қолжетімді ашық беттермен шектелген.')}</p>
    <SnapshotNotice snapshot={queue}/>
    <Counters rows={[[L('Ожидают решения','Шешім күтуде'),queue.data?open.length:null],[L('Высокий риск в очереди','Кезектегі жоғары тәуекел'),queue.data?open.filter(item=>item.analysis?.level==='high').length:null],[L('Рассмотрено человеком','Адам қарастырған'),queue.data?reviewed.length:null]]}/>
   </div>
   <div className="wb-actions"><button className="wb-button primary" onClick={()=>go('review')}><Inbox size={16}/>{L('Открыть очередь','Кезекті ашу')}</button><button className="wb-button" onClick={()=>go('cases')}>{L('Все реальные материалы','Барлық нақты материалдар')}<ArrowRight size={14}/></button></div>
  </section>
  <div className="wb-split">
   <section className="wb-panel">
    <header><h3>{L('Автопоиск Telegram','Telegram автоіздеуі')}</h3><button className="wb-link" onClick={()=>go('discovery')}>{L('Подробнее','Толығырақ')}<ArrowRight size={14}/></button></header>
    <SnapshotNotice snapshot={discovery}/><p>{discovery.error?L('Текущее состояние не подтверждено','Ағымдағы күйі расталмаған'):discoveryState}</p>
    <Counters rows={[[L('Попыток проверки каналов','Арналарды тексеру әрекеттері'),d?.stats?.probes],[L('Каналов с признаками','Белгілері бар арналар'),d?.counts?.risky],[L('Срабатываний на постах','Жазбалардағы белгілер'),d?.stats?.flaggedPosts],[L('Каналов в очереди поиска','Іздеу кезегіндегі арналар'),d?.counts?.queued],[L('Недоступно / ошибка','Қолжетімсіз / қате'),d?.counts?.unavailable]]}/>
    <p className="wb-note">{L('Последний запуск','Соңғы іске қосылуы')}: {time(d?.stats?.lastRunAt)}</p>
   </section>
   <section className="wb-panel">
    <header><h3>{L('Мониторинг выбранных Telegram-каналов','Таңдалған Telegram арналарын бақылау')}</h3><button className="wb-link" onClick={()=>go('monitor')}>{L('Подробнее','Толығырақ')}<ArrowRight size={14}/></button></header>
    <SnapshotNotice snapshot={watchtower}/><p>{watchtower.error?L('Текущее состояние не подтверждено','Ағымдағы күйі расталмаған'):sourceState(w)}</p>
    <Counters rows={[[L('Настроено каналов','Бапталған арналар'),w?.sources?.length],[L('Проверок сообщений','Хабарламаларды тексеру саны'),w?.stats?.checkedPosts],[L('Сохранено случаев','Сақталған жағдайлар'),w?.stats?.savedCases],[L('Ошибок источников','Дереккөз қателері'),w?.stats?.failedSources]]}/>
    <p className="wb-note">{L('Последний запуск','Соңғы іске қосылуы')}: {time(w?.lastRunAt)} · {L('Медиа без подписи этот сборщик не распознаёт.','Бұл жинағыш жазбасыз медианы танымайды.')}</p>
   </section>
  </div>
  <section className="wb-panel">
   <header><h3>Instagram · TikTok</h3><button className="wb-link" onClick={()=>go('social')}>{L('Подробнее','Толығырақ')}<ArrowRight size={14}/></button></header>
   <SnapshotNotice snapshot={social}/>
   <ul className="wb-sources">{['instagram','tiktok'].map(platform=><li key={platform}><Radio size={16}/><div><strong>{platform==='instagram'?'Instagram':'TikTok'}</strong><p>{social.error?L('Текущее состояние не подтверждено','Ағымдағы күйі расталмаған'):socialPlatformStatus(s,platform)}</p></div></li>)}</ul>
   <Counters rows={[[L('Поисковых запросов','Іздеу сұраулары'),s?.stats?.searches],[L('Попыток проверки профилей','Профильді тексеру әрекеттері'),s?.stats?.probes],[L('Кандидатов в очереди','Кезектегі үміткерлер'),s?.counts?.queued],[L('Сохранено случаев','Сақталған жағдайлар'),s?.stats?.savedCases]]}/>
   {paused(s?.search?.blockedUntil)&&<p className="wb-note">{L('Поисковая выдача на паузе до','Іздеу нәтижесі кідіртілді, мерзімі')}: {time(s.search.blockedUntil)}</p>}
   <p className="wb-note">{L('Фрагменты поисковой выдачи помечаются отдельно: они не подтверждают чтение профиля. Капча или требование входа останавливает доступ. Полный анализ видео, OCR и речи этим мониторингом не подтверждается.','Іздеу нәтижесінің үзінділері бөлек белгіленеді: олар профильдің оқылғанын растамайды. Капча не кіру талабы қолжетімділікті тоқтатады. Бұл мониторинг толық видео, OCR және сөйлеу талдауын растамайды.')}</p>
  </section>
  <section className="wb-panel">
   <header><h3>{L('Находки, ожидающие решения','Шешім күтетін материалдар')}</h3></header>
   {open.length?<ul className="wb-mini-queue">{open.slice(0,6).map(item=><li key={item.id}><button onClick={()=>onOpen?onOpen(item.id):go('review',{case:item.id})}><Inbox size={18}/><span className="wb-mini-main"><strong>{item.author||item.url||L('Без автора','Авторсыз')}</strong><small>{item.platform} · {isSearchExcerpt(item)?L('фрагмент поисковой выдачи','іздеу нәтижесінің үзіндісі'):L('сохранённый материал','сақталған материал')}</small><span>{(item.text||'').slice(0,140)}</span></span><b>{item.analysis?.score??'—'}/100</b></button></li>)}</ul>:queue.data&&!queue.error?<p className="wb-empty">{L('Реальных находок в очереди пока нет. Это не подтверждает отсутствие риска в источниках.','Кезекте нақты материалдар әзірге жоқ. Бұл дереккөздерде тәуекел жоқ екенін растамайды.')}</p>:null}
  </section>
  <p className="wb-principle"><Info size={15}/>{L('Счётчики источников накопительные и могут включать повторные проверки. Они не складываются в число уникальных публикаций. Балл риска объясняется признаками; решение о законности принимает человек.','Дереккөз санауыштары жинақталған және қайталама тексерулерді қамтуы мүмкін. Олардың қосындысы бірегей жарияланым санын білдірмейді. Тәуекел балы белгілермен түсіндіріледі; заңдылық туралы шешімді адам қабылдайды.')}</p>
 </div>;
}
