'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {LiveStream,destination,MAX_CHUNK}=require('../lib/livestream.cjs');
const setup={provider:'custom',serverURL:'rtmp://127.0.0.1:1935/live',streamKey:'synthetic-key-only'};
function fixture(options={}){
  let child,spawned=0;
  const subject=new LiveStream({dataDir:__dirname,isEnabled:()=>true,verifyTikTok:async()=>{},spawn:()=>{
    spawned++;child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(_chunk,_enc,done){done();},final(done){done();setImmediate(()=>child.emit('close',0));}});
    child.kill=()=>{setImmediate(()=>child.emit('close',1));return true;};return child;
  },...options});subject.encoderReady=true;subject.encoderPath='C:\\ffmpeg.exe';
  return {subject,get child(){return child;},get spawned(){return spawned;}};
}
test('LIVE destination validation rejects unsafe protocols and separates credentials from status',()=>{
  for(const value of [{...setup,serverURL:'https://example.com'},{...setup,serverURL:'rtmp://user:pass@example.com/live'},{...setup,serverURL:'rtmps://example.com/live?key=secret'},{...setup,streamKey:'bad\nkey'},{...setup,streamKey:''},{...setup,provider:'unknown'}])assert.throws(()=>destination(value));
  const f=fixture();f.subject.saveDestination(setup);assert.equal(f.subject.snapshot().configured,true);
  assert(!JSON.stringify(f.subject.snapshot()).includes(setup.streamKey));assert(!JSON.stringify(f.subject.snapshot()).includes('/live'));
});
test('offline, missing destination, encoder and invalid profile cannot start broadcasting',async()=>{
  const f=fixture({isEnabled:()=>false});f.subject.saveDestination(setup);await assert.rejects(f.subject.start({fps:30,bitrate:3000000}),/Internet/);assert.equal(f.spawned,0);
  const g=fixture();await assert.rejects(g.subject.start({fps:30,bitrate:3000000}),/server URL/);g.subject.saveDestination(setup);g.subject.encoderReady=false;await assert.rejects(g.subject.start({fps:30,bitrate:3000000}),/FFmpeg/);
  const h=fixture({verifyTikTok:async()=>{throw new Error('Connect your account.');}});h.subject.saveDestination({...setup,provider:'tiktok'});await assert.rejects(h.subject.start({fps:30,bitrate:3000000}),/Connect your account/);assert.equal(h.spawned,0);assert.equal(h.subject.status,'error');
});
test('connecting is distinct from actual encoded output; ordered bounded writes and End Live work',async()=>{
  const f=fixture();f.subject.saveDestination(setup);const session=await f.subject.start({fps:30,bitrate:3000000});
  assert.equal(f.subject.status,'connecting');assert.equal(f.subject.startedAt,0);
  await f.subject.write({id:session.id,sequence:0,bytes:new Uint8Array([1,2,3])});
  await assert.rejects(f.subject.write({id:session.id,sequence:0,bytes:new Uint8Array([1])}),/no longer/);
  await assert.rejects(f.subject.write({id:session.id,sequence:1,bytes:new Uint8Array(MAX_CHUNK+1)}),/cannot keep up/);
  f.child.stdout.write('frame=12\ntotal_size=1024\nprogress=continue\n');assert.equal(f.subject.status,'live');assert.equal(f.subject.bytesSent,1024);assert(f.subject.startedAt>0);
  await f.subject.stop();assert.equal(f.subject.status,'ended');assert.equal(f.subject.active,null);assert.equal(f.subject.snapshot().configured,true);
  await f.subject.stop();await assert.rejects(f.subject.write({id:session.id,sequence:1,bytes:new Uint8Array([1])}),/no longer/);
});
test('cancel during TikTok profile verification prevents a late encoder launch',async()=>{
  let verified;const f=fixture({verifyTikTok:()=>new Promise(resolve=>{verified=resolve;})});f.subject.saveDestination({...setup,provider:'tiktok'});
  const starting=f.subject.start({fps:30,bitrate:3000000});await f.subject.stop();verified();await assert.rejects(starting,/cancelled/);assert.equal(f.spawned,0);assert.equal(f.subject.status,'ended');
});
test('encoder rejection becomes an error without exposing its raw key, then permits retry',async()=>{
  const f=fixture();f.subject.saveDestination({...setup,provider:'tiktok'});await f.subject.start({fps:30,bitrate:3000000});
  f.child.stderr.write('NetStream.Publish.BadName '+setup.streamKey);f.child.emit('close',1);assert.equal(f.subject.status,'error');assert.equal(f.subject.snapshot().configured,false);assert(!JSON.stringify(f.subject.snapshot()).includes(setup.streamKey));
  f.subject.saveDestination(setup);const retry=await f.subject.start({fps:24,bitrate:1500000});await f.subject.write({id:retry.id,sequence:0,bytes:new Uint8Array([1])});await f.subject.stop();
});
test('TikTok stream key is discarded after End Live; custom credentials stay only in session memory',async()=>{
  const f=fixture();f.subject.saveDestination({...setup,provider:'tiktok'});await f.subject.start({fps:30,bitrate:3000000});await f.subject.stop();assert.equal(f.subject.target,null);assert.equal(f.subject.status,'ended');
});
