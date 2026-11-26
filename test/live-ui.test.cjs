'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const ready={status:'ready',configured:true,provider:'tiktok',encoderReady:true,active:false,startedAt:0,bytesSent:0,message:'Ready'};
async function fixture(api={}){
  const elements=new Map();let status;
  const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',hidden:false,disabled:false,listeners:{},classList:{toggle(){}},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(id);};
  const window={studio:{onLiveStatus:fn=>status=fn,...api}},document={querySelector:get};
  vm.runInNewContext(await fs.readFile(path.join(__dirname,'../live.js'),'utf8'),{window,document,Date,setInterval:()=>{}});
  window.liveOutput.initialize(ready,{lockControls(){}});
  return {get,subject:window.liveOutput,status:next=>status(next),event:(id,event)=>get(id).listeners[event]({preventDefault(){}})};
}
test('LIVE UI requires both a destination and linked TikTok profile; Custom output has a separate path',async()=>{
  const f=await fixture();assert.equal(f.get('#live-start').disabled,true);f.subject.setTikTok({hasSavedLink:true,profile:{displayName:'Test Creator'}});assert.equal(f.get('#live-start').disabled,false);assert.equal(f.get('#live-account').textContent,'Test Creator');
  f.subject.setInternetEnabled(false);assert.equal(f.get('#live-start').disabled,true);f.subject.setInternetEnabled(true);f.status({...ready,provider:'custom'});f.subject.setTikTok({});assert.equal(f.get('#live-start').disabled,false);
});
test('start, connecting, live, stopping and disconnected states expose appropriate controls',async()=>{
  const f=await fixture();f.status({...ready,status:'connecting',active:true});assert.equal(f.get('#live-start').hidden,true);assert.equal(f.get('#live-end').hidden,false);assert.equal(f.get('#live-end').textContent,'Cancel connection');
  f.status({...ready,status:'live',active:true,startedAt:Date.now()-65000});assert.equal(f.get('#live-state').textContent,'LIVE');assert.equal(f.get('#live-clock').textContent,'00:01:05');assert.equal(f.get('#live-end').textContent,'End Live');assert.equal(f.get('#live-setup-open').disabled,true);
  f.status({...ready,status:'stopping',active:true});assert.equal(f.get('#live-end').disabled,true);f.status({...ready,status:'error',active:false,message:'Server refused the key.'});assert.equal(f.get('#live-state').textContent,'DISCONNECTED');assert.equal(f.get('#live-end').hidden,true);assert.equal(f.get('#live-status').textContent,'Server refused the key.');
});
test('saving LIVE setup clears the secret field without sending it back in status; validation preserves entered data',async()=>{
  let received;const f=await fixture({saveLiveDestination:async input=>{received=input;return ready;}});f.get('#live-provider').value='tiktok';f.get('#live-server-url').value='rtmps://example.invalid/live';f.get('#live-stream-key').value='synthetic-private-key';
  await f.event('#live-setup-form','submit');assert.equal(received.streamKey,'synthetic-private-key');assert.equal(f.get('#live-stream-key').value,'');
  const g=await fixture({saveLiveDestination:async()=>{throw new Error("Error invoking remote method 'studio:live-save-destination': Error: Enter a valid server URL.");}});g.get('#live-stream-key').value='keep-input';await g.event('#live-setup-form','submit');assert.equal(g.get('#live-stream-key').value,'keep-input');assert.equal(g.get('#live-setup-status').textContent,'Enter a valid server URL.');
});
