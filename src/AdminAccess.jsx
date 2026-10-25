import React, {useEffect, useRef, useState} from 'react';
import {Info, KeyRound, LoaderCircle, LogOut, X} from 'lucide-react';
import {getLanguage} from './i18n.js';
import {fetchWithAccess} from './access-session.js';
import './admin-access.css';

const L=(ru,kk)=>getLanguage()==='kk'?kk:ru;
export const authErrorText=code=>({
 invalid_code:L('Неверный код администратора. Попробуйте ещё раз.','Әкімші коды қате. Қайталап көріңіз.'),
 unconfigured:L('Вход по коду на сервере не настроен.','Серверде код арқылы кіру бапталмаған.'),
 rate_limited:L('Слишком много попыток. Подождите и попробуйте позже.','Әрекет тым көп. Күтіп, кейінірек қайталаңыз.'),
 unavailable:L('Не удалось связаться с сервером. Повторите попытку.','Сервермен байланысу мүмкін болмады. Қайталап көріңіз.'),
 logout_failed:L('Не удалось подтвердить выход. Повторите попытку.','Жүйеден шығу расталмады. Қайталап көріңіз.'),
})[code]||L('Не удалось выполнить запрос. Попробуйте ещё раз.','Сұрау орындалмады. Қайталап көріңіз.');

export async function authRequest(path,options={}){
 const response=await fetchWithAccess(path,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});
 if(!response.ok)throw new Error(({401:'invalid_code',503:'unconfigured',429:'rate_limited'})[response.status]||'unavailable');
 return response.json();
}

export function AccessBanner({mode,modeLabel,readOnly,adminLoginEnabled,expiresAt,onLogin,onLogout,logoutBusy,logoutError,onRetry}){
 const admin=mode==='hosted_admin';
 return <section className={`mode-banner ${readOnly?'read-only':''}`} aria-label={L('Режим работы','Жұмыс режимі')}>
  <Info size={20} aria-hidden="true"/>
  <div><strong role="status">{modeLabel}</strong>
   <p>{mode==='public_read_only'?L('Вы просматриваете сайт как гость. Сохранённые случаи доступны для чтения; ручной анализ текста и OCR работает без сохранения. Вход администратора открывает сохранение, редактирование и настройки.','Сіз сайтты қонақ ретінде қарап отырсыз. Сақталған жағдайларды оқуға болады; мәтін талдауы мен OCR нәтижесі сақталмайды. Әкімші ретінде кіру сақтау, өңдеу және баптауларды ашады.'):admin?L('Вы вошли как администратор. Результаты сохраняются на сервере; редактирование случаев и настройки доступны.','Сіз әкімші ретінде кірдіңіз. Нәтижелер серверде сақталады; жағдайларды өңдеу мен баптаулар қолжетімді.'):mode==='hosted_private'?L('Данные и результаты анализа сохраняются на этом сервере. Изменение случаев и настроек доступно.','Деректер мен талдау нәтижелері осы серверде сақталады. Жағдайлар мен баптауларды өзгерту қолжетімді.'):mode==='local'?L('Результаты анализа сохраняются на локальном сервере. Изменение случаев и настроек доступно.','Талдау нәтижелері жергілікті серверде сақталады. Жағдайлар мен баптауларды өзгерту қолжетімді.'):L('Не удалось подтвердить режим сервера. Изменения отключены до получения ответа.','Сервер режимін растау мүмкін болмады. Жауап келгенше өзгерістер өшірілген.')}</p>
   {admin&&expiresAt&&<p>{L('Сессия действует до','Сессия мерзімі')}: <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString(getLanguage()==='kk'?'kk-KZ':'ru-RU')}</time></p>}
   {mode==='public_read_only'&&!adminLoginEnabled&&<p>{authErrorText('unconfigured')}</p>}
   {logoutError&&<p className="admin-access-error" role="alert">{authErrorText(logoutError)}</p>}
  </div>
  {mode==='public_read_only'&&adminLoginEnabled&&<button id="admin-session-action" className="button secondary small" onClick={onLogin}><KeyRound size={16}/>{L('Войти как администратор','Әкімші ретінде кіру')}</button>}
  {admin&&<button id="admin-session-action" className="button secondary small" disabled={logoutBusy} onClick={onLogout}>{logoutBusy?<LoaderCircle className="spin" size={16}/>:<LogOut size={16}/>} {logoutBusy?L('Выходим…','Шығу…'):L('Выйти','Шығу')}</button>}
  {!mode&&<button className="button secondary small" onClick={onRetry}>{L('Повторить','Қайталау')}</button>}
 </section>;
}

export function AdminLoginDialog({onClose,onAuthenticated}){
 const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[checking,setChecking]=useState(true),[error,setError]=useState(''),[enabled,setEnabled]=useState(false),[attempt,setAttempt]=useState(0);
 const dialog=useRef(null),input=useRef(null),request=useRef(null),active=useRef(false),submitting=useRef(false);
 const authenticated=useRef(onAuthenticated);
 authenticated.current=onAuthenticated;
 useEffect(()=>{
  active.current=true;
  const previousOverflow=document.body.style.overflow;
  document.body.style.overflow='hidden';dialog.current?.focus();
  return()=>{active.current=false;request.current?.abort();document.body.style.overflow=previousOverflow;};
 },[]);
 useEffect(()=>{
  let current=true;
  const controller=new AbortController();request.current=controller;
  setChecking(true);setError('');
  authRequest('/api/auth/session',{signal:controller.signal}).then(async session=>{
   if(!current)return;
   if(session.authenticated){setCode('');await authenticated.current();return;}
   setEnabled(session.enabled===true);
   if(!session.enabled)setError('unconfigured');
  }).catch(failure=>{if(current&&failure.name!=='AbortError'){setEnabled(false);setError('unavailable');}}).finally(()=>{if(current)setChecking(false);});
  return()=>{current=false;controller.abort();};
 },[attempt]);
 useEffect(()=>{if(!checking&&enabled&&!busy)input.current?.focus();},[checking,enabled,busy]);
 const close=()=>{setCode('');request.current?.abort();onClose();};
 async function submit(event){
  event.preventDefault();
  if(submitting.current||checking||!enabled||!code.trim())return;
  submitting.current=true;setBusy(true);setError('');
  const controller=new AbortController();request.current=controller;
  try{
   const result=await authRequest('/api/auth/login',{method:'POST',body:JSON.stringify({code}),signal:controller.signal});
   if(!active.current)return;
   if(result.authenticated!==true)throw new Error('unavailable');
   setCode('');await authenticated.current();
  }catch(failure){if(active.current&&failure.name!=='AbortError'){setError(['invalid_code','unconfigured','rate_limited'].includes(failure.message)?failure.message:'unavailable');if(failure.message==='unconfigured')setEnabled(false);}}
  finally{if(active.current){setBusy(false);submitting.current=false;}}
 }
 function keyDown(event){
  event.stopPropagation();
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key!=='Tab')return;
  const controls=dialog.current?.querySelectorAll('button:not(:disabled),input:not(:disabled)');
  if(!controls?.length)return;
  const first=controls[0],last=controls[controls.length-1],focused=document.activeElement;
  if(event.shiftKey&&(focused===first||focused===dialog.current)){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(focused===last||focused===dialog.current)){event.preventDefault();first.focus();}
 }
 return <div className="admin-access-backdrop" onClick={event=>{if(event.target===event.currentTarget)close();}}>
  <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-login-title" aria-describedby="admin-login-help" className="admin-access-dialog" onKeyDown={keyDown}>
   <header><h2 id="admin-login-title">{L('Вход администратора','Әкімшінің кіруі')}</h2><button type="button" className="icon-button" aria-label={L('Закрыть вход','Кіру терезесін жабу')} onClick={close}><X size={20}/></button></header>
   <p id="admin-login-help">{L('Введите код администратора, чтобы сохранять результаты, редактировать случаи и менять настройки.','Нәтижелерді сақтау, жағдайларды өңдеу және баптауларды өзгерту үшін әкімші кодын енгізіңіз.')}</p>
   <form onSubmit={submit} aria-busy={busy||checking}>
    <label className="field-label" htmlFor="admin-code">{L('Код администратора','Әкімші коды')}</label>
    <input ref={input} id="admin-code" className="standalone-input" type="password" value={code} onChange={event=>setCode(event.target.value)} disabled={busy||checking||!enabled} autoComplete="off" autoCapitalize="none" spellCheck={false} required aria-invalid={error==='invalid_code'} aria-describedby={error?'admin-login-error':'admin-login-help'}/>
    {checking&&<p role="status"><LoaderCircle className="spin" size={16}/>{L('Проверяем доступность входа…','Кіру қолжетімділігі тексерілуде…')}</p>}
    {error&&<p id="admin-login-error" className="admin-access-error" role="alert">{authErrorText(error)}</p>}
    {!checking&&!enabled&&<button className="text-button" type="button" onClick={()=>setAttempt(value=>value+1)}>{L('Проверить снова','Қайта тексеру')}</button>}
    <div className="admin-access-actions"><button type="button" className="button secondary" onClick={close}>{L('Отмена','Бас тарту')}</button><button className="button primary" type="submit" disabled={busy||checking||!enabled||!code.trim()}>{busy?<LoaderCircle className="spin" size={16}/>:<KeyRound size={16}/>} {busy?L('Входим…','Кіру…'):L('Войти','Кіру')}</button></div>
   </form>
  </section>
 </div>;
}
