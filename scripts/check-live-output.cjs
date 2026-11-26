'use strict';
// A private integration check. All media is generated, and RTMP binds to loopback.
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const assert=require('node:assert/strict');
const {LiveStream}=require('../lib/livestream.cjs');
const execute=promisify(execFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const root=path.resolve(__dirname,'../.cache/live-output-integration-'+Date.now());await fs.mkdir(root,{recursive:true});
  const studio=new LiveStream({dataDir:root,isEnabled:()=>true,verifyTikTok:async()=>{throw new Error('This local check never uses TikTok.');}});
  await studio.initialize();assert(studio.encoderReady,'Install FFmpeg with libx264 before running this check.');
  const source=path.join(root,'synthetic.webm'),received=path.join(root,'received.mkv');
  await execute(studio.encoderPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','5','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-c:a','libopus',source],{windowsHide:true,timeout:15000});
  const allocator=net.createServer();await new Promise(resolve=>allocator.listen(0,'127.0.0.1',resolve));const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
  const url=`rtmp://127.0.0.1:${port}/live`,key='synthetic-loopback-only';
  const receiver=spawn(studio.encoderPath,['-hide_banner','-loglevel','error','-listen','1','-i',url+'/'+key,'-c','copy','-f','matroska',received],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let receiverError='';receiver.stderr.on('data',x=>receiverError+=x);const receiverExit=new Promise(resolve=>receiver.once('close',resolve));
  try{
    await pause(600);studio.saveDestination({provider:'custom',serverURL:url,streamKey:key});const output=await studio.start({fps:24,bitrate:1500000});
    const media=await fs.readFile(source);let sequence=0;
    for(let at=0;at<media.length;at+=8192){await studio.write({id:output.id,sequence:sequence++,bytes:media.subarray(at,at+8192)});await pause(30);}
    const deadline=Date.now()+12000;while(studio.status!=='live'&&Date.now()<deadline){if(studio.status==='error')throw new Error(studio.message);await pause(100);}
    assert.equal(studio.status,'live','Encoder never reported successful live output.');assert(studio.bytesSent>0);
    await studio.stop();assert.equal(studio.status,'ended');await Promise.race([receiverExit,pause(5000)]);
    const probe=await execute('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type','-show_entries','format=duration','-of','json',received],{windowsHide:true,timeout:5000});
    const metadata=JSON.parse(probe.stdout);assert(metadata.streams.some(x=>x.codec_name==='h264'));assert(metadata.streams.some(x=>x.codec_name==='aac'));assert(+metadata.format.duration>1);
    const result={passed:true,transport:'RTMP over 127.0.0.1 only',codecs:metadata.streams,duration:Number(metadata.format.duration),ended:studio.status,artifact:received};await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await studio.stop();receiver.kill();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
