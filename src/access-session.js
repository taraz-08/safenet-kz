import {useCallback, useEffect, useRef, useState} from 'react';

export const ACCESS_REQUIRED_EVENT='safenet:access-required';
export const SESSION_DATA_EVENT='safenet:session-data';
export const canWriteMode=mode=>['local','hosted_private','hosted_admin'].includes(mode);

// Cookies stay with the browser. This wrapper never reads or stores credentials.
export async function fetchWithAccess(path,options={}){
 const response=await fetch(path,{credentials:'same-origin',...options});
 if([401,403].includes(response.status)&&!String(path).startsWith('/api/auth/')){
  window.dispatchEvent(new Event(ACCESS_REQUIRED_EVENT));
 }
 return response;
}

export function useServerAccess(){
 const [state,setState]=useState({health:false,mode:null,liveOnly:true,adminLoginEnabled:false,adminSessionExpiresAt:null});
 const version=useRef(0),mounted=useRef(false);
 const refreshHealth=useCallback(async()=>{
  const requestVersion=++version.current;
  try{
   const response=await fetch('/api/health',{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw new Error('health_unavailable');
   const data=await response.json();
   if(!mounted.current||requestVersion!==version.current)return null;
   const knownMode=['local','public_read_only','hosted_private','hosted_admin'].includes(data.mode);
   const expired=data.mode==='hosted_admin'&&Date.parse(data.adminSessionExpiresAt)<=Date.now();
   const mode=data.ok&&knownMode?(expired?'public_read_only':data.mode):null;
   setState(previous=>({health:!!data.ok,mode,liveOnly:data.ok?data.liveOnly===true:previous.liveOnly,adminLoginEnabled:!!data.ok&&data.adminLoginEnabled===true,adminSessionExpiresAt:mode==='hosted_admin'?data.adminSessionExpiresAt||null:null}));
   return {...data,mode};
  }catch{
   if(mounted.current&&requestVersion===version.current)setState(previous=>({...previous,health:false,mode:null,adminLoginEnabled:false,adminSessionExpiresAt:null}));
   return null;
  }
 },[]);
 useEffect(()=>{
  mounted.current=true;
  const recheck=()=>{
   setState(previous=>({...previous,mode:null,adminSessionExpiresAt:null}));
   void refreshHealth();
  };
  window.addEventListener(ACCESS_REQUIRED_EVENT,recheck);
  refreshHealth();
  const timer=setInterval(refreshHealth,15000);
  return()=>{mounted.current=false;++version.current;clearInterval(timer);window.removeEventListener(ACCESS_REQUIRED_EVENT,recheck);};
 },[refreshHealth]);
 useEffect(()=>{
  if(state.mode!=='hosted_admin'||!state.adminSessionExpiresAt)return;
  const remaining=Date.parse(state.adminSessionExpiresAt)-Date.now();
  if(!Number.isFinite(remaining))return;
  const timer=setTimeout(()=>{
   if(Date.parse(state.adminSessionExpiresAt)>Date.now()){void refreshHealth();return;}
   setState(previous=>({...previous,mode:'public_read_only',adminSessionExpiresAt:null}));
   void refreshHealth();
  },Math.max(0,Math.min(remaining,2147483647)));
  return()=>clearTimeout(timer);
 },[state.mode,state.adminSessionExpiresAt,refreshHealth]);
 return {...state,refreshHealth};
}
