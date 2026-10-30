(()=>{"use strict";
const $=id=>document.getElementById(id),sec=$("mensa"),btn=$("mensaBtn");let data=null,cur=null;
const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],DL={vegan:"Vegan",vegetarian:"Vegetarian",meat:"Meat/Fish"};
const iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
function go(date){if(!date||date===cur)return;const ix=data.days.findIndex(d=>d.date===date),io=data.days.findIndex(d=>d.date===cur),L=$("mList");
 if(matchMedia("(prefers-reduced-motion: reduce)").matches){cur=date;render();return}
 L.style.setProperty("--dx",(ix>io?-24:24)+"px");L.classList.add("fade");setTimeout(()=>{cur=date;render();L.classList.remove("fade")},140)}
function shiftM(n){const i=data.days.findIndex(d=>d.date===cur),d=data.days[i+n];if(d)go(d.date)}
function render(){const days=$("mDays"),list=$("mList");days.replaceChildren();list.replaceChildren();
 const today=iso(new Date());
 data.days.forEach(d=>{const dt=new Date(d.date+"T12:00"),b=el("button",d.date===cur?"on":"");
  b.append(el("b",null,d.date===today?"Today":WD[dt.getDay()]),el("small",null,dt.getDate()+"."+(dt.getMonth()+1)+"."));
  b.onclick=()=>go(d.date);days.append(b)});
 days.querySelector(".on")?.scrollIntoView({block:"nearest",inline:"nearest"});
 const day=data.days.find(d=>d.date===cur);
 if(!day||!day.dishes.length){list.append(el("li","mempty","No menu for this day (closed or not published yet)."));}
 else day.dishes.forEach(x=>{const li=el("li","dish d-"+(x.diet||"none"));
  const top=el("div","dtop");top.append(el("span","dtype",x.type||"Dish"));if(x.diet)top.append(el("span","diet",DL[x.diet]));
  li.append(top,el("div","dname",x.name));
  if(x.allergens.length)li.append(el("div","dall","Allergens: "+x.allergens.join(", ")));list.append(li)});
 $("mInfo").textContent="Updated "+new Date(data.fetched).toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"})+". Public menu data, may change on short notice.";
}
async function open_(){sec.hidden=false;btn.setAttribute("aria-expanded","true");sec.scrollIntoView({block:"start"});
 if(data)return;$("mList").replaceChildren(el("li","mempty","Loading…"));
 try{const r=await fetch("data/mensa-ottobrunn.json?t="+Math.floor(Date.now()/36e5),{cache:"no-cache"});data=await r.json();
  $("mSrc").href=data.source;const t=iso(new Date());cur=(data.days.find(d=>d.date>=t)||data.days[data.days.length-1]||{}).date;render();}
 catch(e){$("mList").replaceChildren(el("li","mempty","Could not load the menu."));}}
let tx=null,ty=0;$("mList").addEventListener("touchstart",e=>{if(e.touches.length>1){tx=null;return}tx=e.touches[0].clientX;ty=e.touches[0].clientY},{passive:true});
$("mList").addEventListener("touchend",e=>{if(tx==null||!data)return;const dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;tx=null;if(Math.abs(dx)>70&&Math.abs(dx)>2*Math.abs(dy))shiftM(dx>0?-1:1)},{passive:true});
btn.onclick=()=>sec.hidden?open_():(sec.hidden=true,btn.setAttribute("aria-expanded","false"));
$("mClose").onclick=()=>{sec.hidden=true;btn.setAttribute("aria-expanded","false")};
})();
