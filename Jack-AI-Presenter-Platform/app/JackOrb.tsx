"use client";

import { useEffect, useRef } from "react";

export type JackState = "idle" | "available" | "listening" | "thinking" | "speaking" | "acting" | "alert";

export const JACK_STATES = {
  idle: { rotationSpeed:.22, pulseSpeed:.55, glow:.48, flash:0, rings:false, waves:false, color:[0,205,255], outer:[0,150,210], label:"Idle", description:"Calm and present" },
  available: { rotationSpeed:.38, pulseSpeed:.85, glow:.64, flash:.04, rings:false, waves:false, color:[0,228,255], outer:[0,175,235], label:"Available", description:"Ready to help" },
  listening: { rotationSpeed:.62, pulseSpeed:1.75, glow:.76, flash:.12, rings:true, waves:false, color:[16,238,255], outer:[6,195,238], label:"Listening", description:"Actively listening" },
  thinking: { rotationSpeed:1.18, pulseSpeed:3.1, glow:.70, flash:.42, rings:false, waves:false, color:[55,196,255], outer:[25,155,238], label:"Thinking", description:"Understanding your material" },
  speaking: { rotationSpeed:.48, pulseSpeed:1.55, glow:.88, flash:.22, rings:false, waves:true, color:[0,248,255], outer:[0,205,242], label:"Speaking", description:"Presenting with you" },
  acting: { rotationSpeed:1.52, pulseSpeed:2.55, glow:1, flash:.52, rings:true, waves:true, color:[0,255,215], outer:[0,215,185], label:"Acting", description:"Taking action" },
  alert: { rotationSpeed:.8, pulseSpeed:4.2, glow:1, flash:.68, rings:true, waves:false, color:[255,118,28], outer:[215,75,8], label:"Alert", description:"Needs attention" },
} as const;

function points(count:number, radius:number) {
  const phi=(1+Math.sqrt(5))/2;
  return Array.from({length:count},(_,i)=>{const theta=Math.acos(1-(2*(i+.5))/count), a=(2*Math.PI*i)/phi; return {x:radius*Math.sin(theta)*Math.cos(a),y:radius*Math.sin(theta)*Math.sin(a),z:radius*Math.cos(theta),spark:0};});
}

export function JackOrb({state="available",size=240}:{state?:JackState;size?:number}) {
  const ref=useRef<HTMLCanvasElement>(null), stateRef=useRef(state);
  useEffect(()=>{stateRef.current=state},[state]);
  useEffect(()=>{
    const canvas=ref.current; if(!canvas)return;
    const ctx=canvas.getContext("2d")!, dpr=window.devicePixelRatio||1;
    canvas.width=size*dpr; canvas.height=size*dpr; canvas.style.width=`${size}px`; canvas.style.height=`${size}px`; ctx.scale(dpr,dpr);
    const cx=size/2,cy=size/2,sr=size*.30, ps=points(size>200?80:size>100?55:32,sr), start=performance.now();
    let raf=0,lastWave=0,waves:{r:number;o:number}[]=[];
    const frame=(now:number)=>{
      const t=(now-start)/1000,cfg=JACK_STATES[stateRef.current], [r,g,b]=cfg.color,[or,og,ob]=cfg.outer;
      ctx.clearRect(0,0,size,size); const pulse=.5+.5*Math.sin(t*cfg.pulseSpeed*Math.PI*2);
      if(cfg.waves&&now-lastWave>720){waves.push({r:sr*.9,o:.65});lastWave=now} waves=waves.map(w=>({r:w.r+sr*.0065,o:w.o-.01})).filter(w=>w.o>0);
      const bloom=ctx.createRadialGradient(cx,cy,0,cx,cy,size*.5); bloom.addColorStop(0,`rgba(${r},${g},${b},.09)`);bloom.addColorStop(1,"transparent");ctx.fillStyle=bloom;ctx.fillRect(0,0,size,size);
      for(let i=5;i>=0;i--){const radius=sr*(1.34+i*.14),alpha=cfg.glow*(.115-i*.02)*(.5+pulse*.5),grad=ctx.createRadialGradient(cx,cy,sr*.72,cx,cy,radius);grad.addColorStop(0,`rgba(${or},${og},${ob},${alpha*2})`);grad.addColorStop(.42,`rgba(${or},${og},${ob},${alpha*.55})`);grad.addColorStop(1,"transparent");ctx.fillStyle=grad;ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill()}
      if(cfg.rings) for(let i=0;i<3;i++){const p=(t*cfg.pulseSpeed*.75+i*.92)%(Math.PI*2);ctx.strokeStyle=`rgba(${r},${g},${b},${(.07+Math.sin(p*Math.PI)*.11)*cfg.glow})`;ctx.lineWidth=.8;ctx.beginPath();ctx.ellipse(cx,cy,sr*(.9+Math.sin(p*Math.PI)*.09)*1.24,sr*.27,i*.62,0,Math.PI*2);ctx.stroke()}
      waves.forEach(w=>{ctx.strokeStyle=`rgba(${r},${g},${b},${w.o*.42})`;ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(cx,cy,w.r,0,Math.PI*2);ctx.stroke()});
      const ca=Math.cos(t*cfg.rotationSpeed),sa=Math.sin(t*cfg.rotationSpeed),ct=Math.cos(.38),st=Math.sin(.38);
      const projected=ps.map(p=>{const rx=p.x*ca+p.z*sa,rz=-p.x*sa+p.z*ca,ty=p.y*ct-rz*st,tz=p.y*st+rz*ct,k=1+tz/(sr*2.7);if(Math.random()<cfg.flash*.018)p.spark=1;p.spark=Math.max(0,p.spark-.032);return{x:cx+rx*k,y:cy+ty*k,depth:(tz+sr)/(sr*2),spark:p.spark}});
      const max=sr*.68; for(let i=0;i<projected.length;i++)for(let j=i+1;j<projected.length;j++){const dx=projected[i].x-projected[j].x,dy=projected[i].y-projected[j].y,d=Math.hypot(dx,dy);if(d<max){const a=(1-d/max)*((projected[i].depth+projected[j].depth)/2)*.5*cfg.glow;ctx.strokeStyle=`rgba(${r},${g},${b},${a})`;ctx.lineWidth=(1-d/max)*.88;ctx.beginPath();ctx.moveTo(projected[i].x,projected[i].y);ctx.lineTo(projected[j].x,projected[j].y);ctx.stroke()}}
      projected.forEach(p=>{const n=Math.max(.5,(size/320)*(.72+p.depth*2.3)),a=(.22+p.depth*.78)*cfg.glow;if(p.spark){const h=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,n*10);h.addColorStop(0,`rgba(${r},${g},${b},${p.spark*.52})`);h.addColorStop(1,"transparent");ctx.fillStyle=h;ctx.beginPath();ctx.arc(p.x,p.y,n*10,0,Math.PI*2);ctx.fill()}ctx.fillStyle=`rgba(255,255,255,${a*.96})`;ctx.beginPath();ctx.arc(p.x,p.y,n,0,Math.PI*2);ctx.fill()});
      raf=requestAnimationFrame(frame);
    }; raf=requestAnimationFrame(frame); return()=>cancelAnimationFrame(raf);
  },[size]);
  return <canvas ref={ref} aria-label={`Jack is ${JACK_STATES[state].label}`} />;
}
