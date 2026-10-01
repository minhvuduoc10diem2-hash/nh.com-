(function(){
"use strict";

/* ===== board geometry (read from the reference image) ===== */
const ROWS=12, COLS=11, SP=42, MG=28;
const SEA_MAX=1;      // cols 0..1 = open sea (navy only)
const SHORE=2;        // col 2 = shoreline, everyone allowed
const FORDS=[5,7];    // river crossings open to all
const RIVER_LO=5, RIVER_HI=6;   // river runs between these two rows

const T={
  CMD :{n:"Tư lệnh",     c:"TL",v:10000},
  SCH :{n:"Sở chỉ huy",  c:"SCH",v:0},
  NAVY:{n:"Tàu chiến",   c:"TC",v:80},
  AIR :{n:"Không quân",  c:"KQ",v:45},
  ART :{n:"Pháo binh",   c:"PB",v:32},
  SAM :{n:"Tên lửa",     c:"TLa",v:24},
  TANK:{n:"Xe tăng",     c:"XT",v:22},
  AA  :{n:"Cao xạ",      c:"CX",v:14},
  ENG :{n:"Công binh",   c:"CB",v:12},
  INF :{n:"Bộ binh",     c:"BB",v:11},
  MIL :{n:"Dân quân",    c:"DQ",v:11},
};
const LIGHT=["CMD","INF","ENG","MIL","TANK"];   // may ford the deep river unaided
const CARRIER=["TANK","NAVY","AIR"];              // carriers for general troops (Engineers carry ONLY heavy gear, see HEAVY_RIDER)
const RIDER=["CMD","INF","MIL"];                // general troop transport: may board any CARRIER (or own HQ, CMD only)
const HEAVY_RIDER=["AA","ART","SAM"];           // heavy equipment (Cao xạ, Pháo binh, Tên lửa): carried ONLY by an Engineer, to cross the river
const SCH_BREAKERS=["ENG","TANK","ART","AIR"];  // only these may capture a headquarters
function canCapture(attackerType,target){ return target.type!=="SCH" || SCH_BREAKERS.includes(attackerType); }

const ORTHO=[[1,0],[-1,0],[0,1],[0,-1]];
const DIAG=[[1,1],[1,-1],[-1,1],[-1,-1]];
const ALL8=ORTHO.concat(DIAG);

/* Red's 19 pieces, exactly as positioned in the reference diagram [col,row] */
const RED_SETUP=[
  ["CMD",6,0],
  ["NAVY",1,1],["AIR",4,1],["SCH",5,1],["SCH",7,1],["AIR",8,1],
  ["ART",3,2],["SAM",6,2],["ART",9,2],
  ["NAVY",2,3],["AA",4,3],["TANK",5,3],["TANK",7,3],["AA",8,3],
  ["INF",2,4],["ENG",3,4],["MIL",6,4],["ENG",9,4],["INF",10,4],
];

let bd,turn,mode="local",human="RED",depth=3,sel=null,moves=[],log=[],
    lostR=[],lostB=[],last=null,over=false,warnSide=null,history=[];

const K=(r,c)=>r+","+c;
const inB=(r,c)=>r>=0&&r<ROWS&&c>=0&&c<COLS;
const at=(r,c)=>bd[K(r,c)];
const foe=(p,s)=>p&&p.side!==s;

function setup(){
  bd={};
  for(const [t,c,r] of RED_SETUP){
    bd[K(r,c)]={type:t,side:"RED",hero:false,r,c};
    const mr=ROWS-1-r;
    bd[K(mr,c)]={type:t,side:"BLUE",hero:false,r:mr,c};
  }
  turn="RED";sel=null;moves=[];log=[];lostR=[];lostB=[];last=null;over=false;warnSide=null;history=[];
}

/* ===== terrain ===== */
function isSea(r,c){ return c<=SEA_MAX; }
function isRiverDeep(r,c){ return (r===RIVER_LO||r===RIVER_HI) && !FORDS.includes(c) && c>SEA_MAX; }
function isWater(r,c){ return isSea(r,c) || isRiverDeep(r,c); }
function canStand(t,r,c){
  if(!inB(r,c))return false;
  if(isSea(r,c)) return t==="NAVY"||t==="AIR";
  return true;                       // col 2+ open to all, navy included (shoreline)
}
function navyOk(r,c){
  if(c<=SHORE) return true;                                   // the sea lane itself, any row
  return (r===RIVER_LO||r===RIVER_HI) && c<=FORDS[0];          // deep river, up to the near ford
}
function standOk(t,r,c){
  if(!canStand(t,r,c))return false;
  if(t==="NAVY"&&!navyOk(r,c))return false;
  return true;
}
// heavy ground units (not in LIGHT) may never wade a deep-river cell on a quiet move;
// they may still land there when the move is a capture (crossing to take a piece on the far bank).
function heavyBlocked(t,r,c){ return isRiverDeep(r,c) && !LIGHT.includes(t); }

/* ===== air-defence coverage owned by the enemy of `side` ===== */
function adZone(side){
  const z=new Set();
  for(const p of Object.values(bd)){
    if(p.side===side)continue;
    if(p.type==="AA"||p.type==="NAVY"){   // a warship carries its own AA battery
      z.add(K(p.r,p.c));
      for(const [a,b] of ALL8) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
    if(p.type==="SAM"){
      z.add(K(p.r,p.c));
      for(const [a,b] of ORTHO) for(let s=1;s<=2;s++) if(inB(p.r+a*s,p.c+b*s)) z.add(K(p.r+a*s,p.c+b*s));
      for(const [a,b] of DIAG) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
  }
  return z;
}

/* ===== generic slider ===== */
function slide(p,dirs,max){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(!o){
        if(heavyBlocked(p.type,r,c))break;             // can't wade deep water without being carried
        if(standOk(p.type,r,c))out.push({r,c}); else break;
      } else {
        // capturing across the river is always allowed, even for a heavy unit, at any river segment
        if(foe(o,p.side)&&standOk(p.type,r,c)&&canCapture(p.type,o))out.push({r,c,cap:o});
        break;
      }
    }
  }
  return out;
}
// stand still and capture a Navy target within reach (Infantry/Engineer/AA/Militia); heroic adds a segment
function waterAdjCapture(p){
  const out=[], range=p.hero?2:1;
  for(const [dr,dc] of ALL8){
    for(let s=1;s<=range;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&o.type==="NAVY"&&isWater(r,c)) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}
/* fire without moving */
function fire(p,dirs,max,pred){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&(!pred||pred(o,r,c))) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}

function gen(p){
  if(p.type==="SCH") return [];               // a headquarters never moves or attacks
  const h=p.hero?1:0;
  switch(p.type){
    case "CMD":{
      const out=[];
      for(const [dr,dc] of ORTHO){
        for(let s=1;s<ROWS+COLS;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(!o){ if(standOk("CMD",r,c))out.push({r,c}); else break; }
          else { if(s===1&&foe(o,p.side)&&canCapture("CMD",o))out.push({r,c,cap:o}); break; }
        }
      }
      return out.filter(m=>!faceOff(p,m));
    }
    case "INF": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "ENG": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "AA":  return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "MIL": return slide(p,ALL8,1+h).concat(waterAdjCapture(p));
    case "TANK":{
      const shipPred=(o,r,c)=>o.type==="NAVY"&&isWater(r,c);
      return slide(p,ORTHO,2+h).concat(fire(p,ORTHO,2+h,shipPred))
        .concat(p.hero?slide(p,DIAG,2+h).concat(fire(p,DIAG,2+h,shipPred)):[]);   // hero: diagonals too
    }
    case "SAM": return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h)).filter(m=>!m.cap||m.cap.type!=="NAVY");
    case "ART": {   // moves AND captures by replacement: straight 1-2 cells, diagonal (45°) 1 cell (+1 if hero)
      const shipPred=(o,r,c)=>o.type==="NAVY"&&isWater(r,c);
      return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h))
        .concat(fire(p,ORTHO,2+h,shipPred)).concat(fire(p,DIAG,1+h,shipPred));
    }
    case "AIR": {
      const R=4+h,Z=p.hero?new Set():adZone(p.side),out=[];   // a hero aircraft is stealth: immune to every air-defence zone
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=R;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;                         // only the board edge stops a flight path
          const o=at(r,c), inZ=Z.has(K(r,c));
          if(o && foe(o,p.side) && inZ && canCapture("AIR",o)){
            out.push({r,c,cap:o,trade:true});          // anything inside hostile airspace: one-for-one
            continue;                                   // still free to keep flying past it
          }
          if(!o){ if(!inZ && !isSea(r,c)) out.push({r,c}); continue; }  // safe, empty & landable
          if(inZ) continue;                             // a friendly unit sheltering there: fly on past
          if(foe(o,p.side) && canCapture("AIR",o)){
            const canReplace = !isSea(r,c);              // an aircraft can never finish a move into the sea
            if(canReplace) out.push({r,c,cap:o});
            if(o.type!=="AIR") out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});   // bomb & return to base
          } else if(!foe(o,p.side) && o.type==="NAVY" && !o.rider){
            out.push({r,c,ride:true});                  // land aboard a friendly ship (carrier)
          }
          // any blocker (friend or foe) never stops the flight - keep scanning past it
        }
      }
      return out;
    }
    case "NAVY": {
      const out=[], sailCaps=new Set(), sailR=4+h;
      for(const [dr,dc] of ALL8){      // sails (and fires its missile point-blank) up to 4 segments, any direction
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c)||!navyOk(r,c))break;
          const o=at(r,c);
          if(!o){ out.push({r,c}); continue; }
          if(foe(o,p.side)&&canCapture("NAVY",o)){ out.push({r,c,cap:o}); sailCaps.add(K(r,c)); }
          break;
        }
      }
      for(const [dr,dc] of ALL8){      // anti-ship missile: Navy-only target, stand-fire only when not directly sailable
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&o.type==="NAVY"&&foe(o,p.side)&&!sailCaps.has(K(r,c)))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
          // a guided missile isn't stopped by ordinary obstructions - keep scanning past anything else
        }
      }
      const gunR=3+h;                   // onboard gun: dry-land targets only, always stand-fire
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=gunR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&foe(o,p.side)&&o.type!=="NAVY"&&c>SHORE&&canCapture("NAVY",o))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
        }
      }
      return out;
    }
  }
  return [];
}

function cmdOf(s){
  for(const p of Object.values(bd)) if(p.type==="CMD"&&p.side===s) return p;
  for(const p of Object.values(bd)) if(p.rider&&p.rider.type==="CMD"&&p.rider.side===s) return {type:"CMD",side:s,hero:p.rider.hero,r:p.r,c:p.c,mounted:true};
  return undefined;
}

function faceOff(p,m){
  const e=cmdOf(p.side==="RED"?"BLUE":"RED");
  if(!e)return false;
  if(m.r!==e.r&&m.c!==e.c)return false;
  const a=K(p.r,p.c),b=K(m.r,m.c),sa=bd[a],sb=bd[b];
  delete bd[a]; bd[b]={...p,r:m.r,c:m.c};
  let blocked=false;
  if(m.r===e.r){const lo=Math.min(m.c,e.c),hi=Math.max(m.c,e.c);for(let c=lo+1;c<hi;c++)if(at(m.r,c)){blocked=true;break;}}
  else {const lo=Math.min(m.r,e.r),hi=Math.max(m.r,e.r);for(let r=lo+1;r<hi;r++)if(at(r,m.c)){blocked=true;break;}}
  bd[a]=sa; if(sb)bd[b]=sb; else delete bd[b];
  return !blocked;
}

function cloneBoard(b){
  const out={};
  for(const k in b){ const p=b[k]; out[k]=p.rider?{...p,rider:{...p.rider}}:{...p}; }
  return out;
}

function legal(side){
  const out=[];
  for(const p of Object.values(bd)){
    if(p.side!==side)continue;
    for(const m of gen(p)) out.push({from:{r:p.r,c:p.c},...m,pt:p.type});
    if(p.rider){   // the passenger may hop off and move on its own
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      for(const m of gen(v)) out.push({from:{r:p.r,c:p.c},...m,pt:v.type,off:true});
    }
  }
  for(const p of Object.values(bd)){   // board a friendly carrier
    if(p.side!==side||p.rider)continue;
    const general=RIDER.includes(p.type), heavy=HEAVY_RIDER.includes(p.type);
    if(!general&&!heavy)continue;
    for(const [dr,dc] of (p.type==="MIL"?ALL8:ORTHO)){
      const r=p.r+dr,c=p.c+dc;
      if(!inB(r,c))continue;
      const o=at(r,c);
      if(!o||o.side!==side||o.rider)continue;
      if(general&&(CARRIER.includes(o.type)||(o.type==="SCH"&&p.type==="CMD")))
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
      else if(heavy&&o.type==="ENG")
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
    }
  }
  return out;
}

// is `side`'s commander currently attacked? Uses raw pseudo-legal generation only - never calls
// legalSafe - so it can't recurse into itself while legalSafe is busy filtering.
function inCheck(side){
  const cmd=cmdOf(side);
  if(!cmd) return false;
  const enemy=side==="RED"?"BLUE":"RED";
  for(const p of Object.values(bd)){
    if(p.side!==enemy) continue;
    if(gen(p).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    if(p.rider){
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      if(gen(v).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    }
  }
  return false;
}

// the actual moves a player may choose: every pseudo-legal move that does not leave their own
// commander in check afterward (this is what makes responding to a check mandatory).
function legalSafe(side){
  return legal(side).filter(m=>{
    const snap=cloneBoard(bd);
    sim(m);
    const safe=!inCheck(side);
    bd=snap;
    return safe;
  });
}

/* ===== apply ===== */
function take(p){ if(!p)return; (p.side==="BLUE"?lostB:lostR).push(p.type); }

function play(m,quiet){
  if(!quiet)history.push({bd:JSON.parse(JSON.stringify(bd)),turn,log:log.slice(),lostR:lostR.slice(),lostB:lostB.slice(),last});
  const fk=K(m.from.r,m.from.c), mv=bd[fk];
  if(!mv)return;
  let got=null, actor=null;

  // destroying an occupied square destroys everything on it - a combined piece goes down together
  function destroyStack(r,c){
    const there=at(r,c);
    if(!there)return null;
    if(there.rider) take({...there.rider,side:there.side});
    take(there);
    delete bd[K(r,c)];
    return there;
  }

  if(m.ride){
    const car=at(m.r,m.c);
    car.rider={type:mv.type,side:mv.side,hero:mv.hero};
    delete bd[fk]; actor=car;
    note(m,mv.type,null,mv.type==="AIR"&&car.type==="NAVY"?"hạ cánh xuống tàu":mv.type==="CMD"&&car.type==="SCH"?"vào sở chỉ huy":"lên xe");
  } else if(m.stay){
    got={...m.cap};
    destroyStack(m.tr,m.tc);
    actor=mv;
    note(m,(m.off&&mv.rider)?mv.rider.type:mv.type,got,"bắn tại chỗ");   // a passenger firing from its carrier never harms the carrier
  } else if(m.off){
    const host=at(m.from.r,m.from.c), rd=host.rider;
    delete host.rider;
    if(m.cap){got={...m.cap};destroyStack(m.r,m.c);}
    if(m.trade){ take({...rd}); note(m,rd.type,got,"đổi mạng"); }
    else {
      bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};
      actor=bd[K(m.r,m.c)];
      note(m,rd.type,got,"xuống xe");
    }
  } else if(m.trade){
    got={...m.cap};
    destroyStack(m.r,m.c);
    if(mv.rider) take({...mv.rider,side:mv.side});
    take(mv);
    delete bd[fk];
    note(m,mv.type,got,"đổi mạng");
  } else {
    if(m.cap){ got={...m.cap}; destroyStack(m.r,m.c); }
    delete bd[fk];
    const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
    if(mv.rider)np.rider=mv.rider;
    bd[K(m.r,m.c)]=np; actor=np;
    note(m,mv.type,got,null);
  }

  last={a:m.from,b:{r:m.r,c:m.c}};

  if(actor&&!actor.hero){         // promote whoever now attacks the enemy commander
    if(gen(actor).some(x=>x.cap&&x.cap.type==="CMD")){
      actor.hero=true;
      if(!quiet)toast((actor.side==="RED"?"Đỏ":"Xanh")+": "+T[actor.type].n+" thành quân ANH HÙNG ★");
    }
  }

  if(!cmdOf("RED")) return finish("BLUE","Tư lệnh Đỏ đã bị bắt.");
  if(!cmdOf("BLUE")) return finish("RED","Tư lệnh Xanh đã bị bắt.");

  turn = turn==="RED"?"BLUE":"RED";
  const side=turn==="RED"?"Đỏ":"Xanh", foeSide=turn==="RED"?"BLUE":"RED";
  if(!legalSafe(turn).length){
    if(inCheck(turn)) return finish(foeSide,"Bên "+side+" bị chiếu bí: Tư lệnh bị chiếu và không còn nước giải.");
    return finish(null,"Bên "+side+" hết nước đi nhưng Tư lệnh không bị chiếu (bí nước).");
  }
  if(onlyKingsLeft()) return finish(null,"Hai bên không còn đủ quân để chiếu.");
  if(threefold()) return finish(null,"Thế cờ lặp lại lần thứ 3.");

  warnSide = inCheck(turn)?turn:null;
  if(!quiet){ draw(); setTimeout(aiTurn,60); }
}

function note(m,t,got,tag){
  let s=(log.length+1)+". "+(turn==="RED"?"Đỏ":"Xanh")+" "+T[t].n+" "+m.from.c+","+m.from.r+"→"+(m.tc??m.c)+","+(m.tr??m.r);
  if(got)s+=" (ăn "+T[got.type].n+")";
  if(tag)s+=" ["+tag+"]";
  log.push(s);
}
function posKey(b,t){
  return Object.keys(b).sort().map(k=>{const p=b[k];
    return k+p.type+p.side[0]+(p.hero?1:0)+(p.rider?p.rider.type+p.rider.side[0]+(p.rider.hero?1:0):"");}).join("|")+t;
}
function onlyKingsLeft(){   // neither side owns anything that could ever check the enemy commander
  for(const p of Object.values(bd)){
    if(p.type!=="CMD"&&p.type!=="SCH")return false;
    if(p.rider&&p.rider.type!=="CMD")return false;
  }
  return true;
}
function threefold(){
  const k=posKey(bd,turn); let n=1;
  for(const h of history) if(posKey(h.bd,h.turn)===k) n++;
  return n>=3;
}
function finish(w,why){
  over=true;
  document.getElementById('ovT').textContent=w?((w==="RED"?"ĐỎ":"XANH")+" THẮNG"):"HOÀ";
  document.getElementById('ovP').textContent=why;
  document.getElementById('over').classList.add('on');
  draw();
}

/* ===== icons ===== */
const ICON={
CMD:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M50.0 17.5L58.0 41.5L83.3 41.7L62.9 56.7L70.6 80.8L50.0 66.1L29.4 80.8L37.1 56.7L16.7 41.7L42.0 41.5z"/></svg>`,
INF:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M32 36C32 24.5 40 18.5 50 18.5S68 24.5 68 36z"/><path class="d" d="M50.0 23.8L51.2 27.0L54.6 27.1L51.9 29.2L52.8 32.5L50.0 30.6L47.2 32.5L48.1 29.2L45.4 27.1L48.8 27.0z"/><path class="s" d="M12 44.6h26v3.2H12zM13.5 42.4h3v2.4h-3z"/><path class="s" d="M36 41.6h34v8.4H36z"/><path class="s" d="M70 43l18 5.6 1.4 9.6-19.4-5.6z"/><path class="s" d="M47 50h12l8 15.5-8.4 2.6z"/><path class="s" d="M64 50h7l3.4 10-7.6 1z"/></svg>`,
TANK:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M12.5 39.2h30v3.2h-30z"/><path class="s" d="M35 33h21l6 9.5H31z"/><path class="s" d="M15.5 55.5L29.5 44.5h46l9 9v8h-69z"/><rect class="s" x="21" y="57" width="64" height="12" rx="6"/><g class="d"><circle cx="30" cy="63" r="2.6"/><circle cx="40" cy="63" r="2.6"/><circle cx="50" cy="63" r="2.6"/><circle cx="60" cy="63" r="2.6"/><circle cx="70" cy="63" r="2.6"/><circle cx="78" cy="63" r="2.2"/></g></svg>`,
MIL:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M47 17c8-5 21-1 22 12 .6 7-1.4 12-4.4 15.6H48c-3.6-3-6.2-8-6.2-13.4 0-6.4 1.6-11.4 5.2-14.2z"/><path class="s" d="M52.5 42h11v24h-11z"/><path class="s" d="M28 80l2.4-8.4c.8-2.4 2.6-3.6 5-4.6L50 61l6 4.4 7-4.4 13.6 5.4c3 1.2 5 3 6 5.8L85 80z"/><path class="ld" stroke-width="1.3" stroke-linecap="round" d="M47.5 31c5 .4 11 4.4 12.4 12M55.6 36.6h4.4M61 39.6l-1.3 4.4 2.5.6M57 49.6c2.4.8 4.6.8 6.4-.2"/><path class="ld" stroke-width="1.5" stroke-linecap="round" d="M44 24.5c2-3.4 6-5.4 10-5.4"/><rect class="s" x="21" y="35" width="3.4" height="44" rx="1.2"/><path class="s" d="M22.7 27l2.8 8h-5.6z"/><path class="ld" stroke-width="1.5" d="M25.6 52c7 3 11 8 14 18"/></svg>`,
ENG:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path fill="#58c6ea" d="M12.7 60 A38.6 38.6 0 0 0 87.3 60z"/><path class="s" d="M13.5 49.5h73v10h-73z"/><g class="s"><rect x="17" y="44.5" width="3.4" height="6"/><rect x="33" y="44.5" width="3.4" height="6"/><rect x="49" y="44.5" width="3.4" height="6"/><rect x="65" y="44.5" width="3.4" height="6"/><rect x="80" y="44.5" width="3.4" height="6"/></g><g class="s"><rect x="24" y="59" width="2.2" height="9"/><rect x="40" y="59" width="2.2" height="9"/><rect x="56" y="59" width="2.2" height="9"/><rect x="72" y="59" width="2.2" height="9"/></g></svg>`,
ART:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="ls" stroke="var(--sym)" stroke-width="4.6" d="M47.5 57L31.5 21"/><path class="s" d="M28.6 19.6l6.4-2.8 1.6 3.6-6.4 2.8z"/><path class="ls" stroke="var(--sym)" stroke-width="1.8" d="M52 51.5l4.5 9"/><path class="s" d="M40 55h21v9H40z"/><path class="s" d="M45 52h12v4H45z"/><path class="s" d="M28 65.5h50l4-4.5v12H28z"/><g><circle class="s" cx="34.5" cy="74" r="6"/><circle class="d" cx="34.5" cy="74" r="2.7"/><circle class="s" cx="66.5" cy="74" r="6"/><circle class="d" cx="66.5" cy="74" r="2.7"/></g></svg>`,
AA:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="ls" stroke="var(--sym)" stroke-width="2.8" d="M56 51L26.5 21.5M61.5 47L32 17.5"/><path class="s" d="M48 62l6-11h15l5 11z"/><path class="s" d="M21.5 62h58v6.5h-58z"/><path class="s" d="M78 53h9v12h-9z"/><g><circle class="s" cx="22" cy="69" r="6.6"/><circle class="d" cx="22" cy="69" r="3.3"/><circle class="s" cx="70" cy="72" r="6.6"/><circle class="d" cx="70" cy="72" r="3.3"/></g></svg>`,
SAM:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><g transform="rotate(-40 52 46)"><path class="s" d="M26 43.4h34l9 2.6-9 2.6H26z"/><path class="s" d="M26 43.4l-6-6.2h7.4l4 6.2zM26 48.6l-6 6.2h7.4l4-6.2z"/><path class="s" d="M46 43.4l-3.6-5h5l2.6 5zM46 48.6l-3.6 5h5l2.6-5z"/></g><path class="ls" stroke="var(--sym)" stroke-width="3" d="M49 71l5.5-10"/><path class="s" d="M31 76l9-6h15l5 7.5-2 4.5H33z"/><path class="ld" stroke-width="1.1" d="M42 79h12"/></svg>`,
AIR:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M14 50C17 46.6 26 45.4 36 45.4H76L83 38.5 86 40 81.5 45.6 83.5 50 81.5 54.4 86 60 83 61.5 76 54.6H36C26 54.6 17 53.4 14 50z"/><path class="s" d="M37 46L58 15l9.5 2L64 46zM37 54L58 85l9.5-2L64 54z"/><path class="s" d="M46 32.5c-1.6-2.6-.6-5.6 1.6-6.2 1.8 1.4 2.4 4.2 1.4 7z"/><path class="s" d="M46 67.5c-1.6 2.6-.6 5.6 1.6 6.2 1.8-1.4 2.4-4.2 1.4-7z"/></svg>`,
NAVY:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path fill="#58c6ea" d="M13.7 63 A38.6 38.6 0 0 0 86.3 63z"/><path class="s" d="M13 55.5h74l-8.5 10H21z"/><path class="s" d="M26 48.4c1-3 4-4.6 8-4.6h6c3.6 0 6 1.6 6.6 4.6z"/><path class="ls" stroke="var(--sym)" stroke-width="2.6" d="M31 46.5L17.5 38.5"/><path class="s" d="M47 46h22v9.5H47z"/><path class="s" d="M52 41h13v5H52z"/><g class="d"><rect x="50" y="49" width="3.4" height="3"/><rect x="56" y="49" width="3.4" height="3"/><rect x="62" y="49" width="3.4" height="3"/></g><path class="s" d="M63 21h3v20h-3z"/><path class="s" d="M58.5 27h12v2.2h-12zM60.5 34h8v2h-8z"/><circle class="s" cx="64.5" cy="20" r="2.4"/></svg>`,
SCH:`<svg class="ic" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#e0ad4c"/><circle cx="50" cy="50" r="48.2" class="ld" stroke-width="1.8"/><circle cx="50" cy="50" r="46.2" fill="none" stroke="#b98028" stroke-width=".9"/><circle cx="50" cy="50" r="44" fill="none" stroke="#b9802a" stroke-width="2.4" stroke-dasharray="3.2 2.6"/><circle cx="50" cy="50" r="41.2" fill="none" stroke="#b9802a" stroke-width="1.9" stroke-dasharray="2.6 3.2" stroke-dashoffset="3"/><circle cx="50" cy="50" r="38.6" class="d"/><circle cx="50" cy="50" r="38.6" fill="none" stroke="#f6d27a" stroke-width="1"/><path class="s" d="M14 50.5h5.4v-5.2h6.2v5.2H32v-5.2h6.2v5.2H44v-5.2h6.2v5.2h10V80H14z"/><path class="s" d="M60 58h26v22H60z"/><g class="d"><rect x="23" y="62" width="11" height="8" rx="1"/><path d="M40 80v-8c0-3.5 2.5-5.5 5-5.5s5 2 5 5.5v8z"/><rect x="66" y="66" width="14" height="6" rx="1"/></g><path class="ls" stroke="var(--sym)" stroke-width="3" stroke-linecap="round" d="M73 58V32M73 38L64.5 24M73 38L81.5 24"/><path class="ls" stroke="var(--sym)" stroke-width="2.4" stroke-linecap="round" d="M67 46h12M68.5 52h9"/></svg>`,
};

/* ===== rendering ===== */
const stage=document.getElementById('stage'), terr=document.getElementById('terrain');
const X=c=>MG+c*SP, Y=r=>MG+(ROWS-1-r)*SP;
const W=MG*2+(COLS-1)*SP, H=MG*2+(ROWS-1)*SP;

function terrainSVG(){
  const riverTop=Y(RIVER_HI), riverBot=Y(RIVER_LO);
  let s=`<svg width="${W}" height="${H}" style="display:block">`;
  s+=`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  s+=`<rect x="${X(0)-MG/2}" y="0" width="${X(SHORE)-X(0)+MG/2}" height="${H}" fill="var(--sea)"/>`;
  s+=`<rect x="0" y="${riverTop}" width="${W}" height="${riverBot-riverTop}" fill="var(--sea)"/>`;
  for(const f of FORDS){                    // ford markings
    s+=`<g stroke="#9a8464" stroke-width="2.4" stroke-linecap="round" opacity=".85">`;
    for(let i=0;i<5;i++){
      const fx=X(f)-9+Math.random()*0, ox=[-7,2,-2,8,4][i], oy=riverTop+5+i*((riverBot-riverTop-10)/4);
      s+=`<line x1="${fx+ox}" y1="${oy}" x2="${fx+ox+3}" y2="${oy+7}"/>`;
    }
    s+=`</g>`;
  }
  s+=`<g stroke="var(--grid)" stroke-width="1.6">`;
  for(let c=0;c<COLS;c++) s+=`<line x1="${X(c)}" y1="${Y(ROWS-1)}" x2="${X(c)}" y2="${Y(0)}"/>`;
  for(let r=0;r<ROWS;r++) s+=`<line x1="${X(0)}" y1="${Y(r)}" x2="${X(COLS-1)}" y2="${Y(r)}"/>`;
  s+=`</g>`;
  s+=`<rect x="${X(0)-MG/2}" y="${Y(ROWS-1)-MG/2}" width="${(COLS-1)*SP+MG}" height="${(ROWS-1)*SP+MG}" fill="none" stroke="var(--frame)" stroke-width="3"/>`;
  s+=`<g fill="#6b6b5e" font-size="10" font-family="Georgia">`;
  for(let c=0;c<COLS;c++) s+=`<text x="${X(c)-3}" y="${H-4}">${c}</text>`;
  for(let r=0;r<ROWS;r++) s+=`<text x="2" y="${Y(r)+4}">${r}</text>`;
  s+=`</g></svg>`;
  return s;
}

function draw(){
  stage.style.width=W+"px"; stage.style.height=H+"px";
  terr.innerHTML=terrainSVG();
  [...stage.querySelectorAll('.pc,.mk,.lm')].forEach(e=>e.remove());
  const D=SP*0.92, tilt=stage.classList.contains('flat')?0:46;
  // standing pieces: lift by the radius' vertical extent so their lower edge clears the board plane, and slide toward the viewer so the disc stays centred on its intersection on screen
  const _rad=tilt*Math.PI/180, pz=(D/2)*Math.sin(_rad)+1.5, pY=pz*Math.tan(_rad), pT=(dz)=>`translateY(${pY}px) translateZ(${pz+dz}px) rotateX(-${tilt}deg)`;

  if(last){
    for(const q of [last.a,last.b]){
      const d=document.createElement('div');
      d.className='lm';
      d.style.cssText=`left:${X(q.c)-D/2}px;top:${Y(q.r)-D/2}px;width:${D}px;height:${D}px`;
      stage.appendChild(d);
    }
  }
  for(const p of Object.values(bd)){
    const e=document.createElement('div');
    e.className='pc '+p.side+(sel&&sel.r===p.r&&sel.c===p.c?' sel':'');
    e.style.cssText=`left:${X(p.c)-D/2}px;top:${Y(p.r)-D/2}px;width:${D}px;height:${D}px;transform:${pT(0)}`;
    e.innerHTML=ICON[p.type]+(p.hero?'<span class="hero">★</span>':'')+(p.rider?'<span class="car"></span>':'');
    e.title=T[p.type].n+(p.hero?" ★":"")+(p.rider?(p.type==="NAVY"&&p.rider.type==="AIR"?" (tàu sân bay)":" (cõng "+T[p.rider.type].n+")"):"");
    e.onclick=ev=>{ev.stopPropagation();tap(p.r,p.c);};
    stage.appendChild(e);
  }
  const groups=new Map();
  for(const m of moves){
    const key=(m.tr??m.r)+","+(m.tc??m.c);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(m);
  }
  for(const [key,group] of groups){
    const [tr,tc]=key.split(",").map(Number);
    const anyCap=group.some(x=>x.cap);
    const d=document.createElement('div'), s=anyCap?D*0.5:D*0.34;
    d.className='mk'+(anyCap?' cap':'')+(group.length>1?' multi':'');
    d.style.cssText=`left:${X(tc)-s/2}px;top:${Y(tr)-s/2}px;width:${s}px;height:${s}px;transform:rotateX(-${tilt}deg) translateZ(6px)`;
    stage.appendChild(d);
    const hit=document.createElement('div');
    hit.className='pc hit';
    hit.style.cssText=`left:${X(tc)-D/2}px;top:${Y(tr)-D/2}px;width:${D}px;height:${D}px;background:none;border:none;box-shadow:none;transform:${pT(1)};z-index:5`;
    hit.onclick=ev=>{ev.stopPropagation();chooseAmong(group);};
    stage.appendChild(hit);
  }

  document.getElementById('turnTxt').textContent="Lượt: "+(turn==="RED"?"Đỏ":"Xanh");
  document.getElementById('dot').className="dot "+turn;
  const w=document.getElementById('warn');
  if(warnSide){w.classList.add('on');w.textContent="TƯ LỆNH "+(warnSide==="RED"?"ĐỎ":"XANH")+" BỊ CHIẾU!";}
  else w.classList.remove('on');
  const cap=(el,arr,cls)=>{el.innerHTML=arr.map(t=>`<span class="${cls}">${T[t].c}</span>`).join("");};
  cap(document.getElementById('lostR'),lostR,'RED');
  cap(document.getElementById('lostB'),lostB,'BLUE');
  document.getElementById('log').innerHTML=log.slice().reverse().map(x=>`<div>${x}</div>`).join("");
}

// human-readable label for one candidate move, so a multi-option cell can be explained clearly
function describeMove(m){
  const host=at(m.from.r,m.from.c), stacked=host&&host.rider;
  if(m.ride){
    const carrier=at(m.r,m.c);
    if(m.pt==="CMD"&&carrier&&carrier.type==="SCH") return "Vào ẩn náu trong Sở chỉ huy";
    return "Cõng lên "+(carrier?T[carrier.type].n:"phương tiện");
  }
  if(m.off) return "Tách ra đi một mình"+(m.cap?" — ăn "+T[m.cap.type].n:"");
  if(m.trade) return "Đổi 1–1 — tiêu diệt "+T[m.cap.type].n+" (cả hai cùng mất)";
  if(m.stay) return "Bắn tại chỗ — tiêu diệt "+T[m.cap.type].n+", đứng nguyên vị trí";
  if(m.cap){
    let s="Thế chỗ — tiêu diệt "+T[m.cap.type].n;
    if(stacked) s+=" (đi cả đôi)";
    return s;
  }
  if(stacked) return "Đi cả đôi (mang theo "+T[host.rider.type].n+")";
  return "Di chuyển tới đây";
}

// when a target cell has more than one legal option (e.g. thế chỗ vs bắn tại chỗ, or đi đôi vs tách ra),
// let the player pick explicitly instead of silently guessing which one they meant.
function chooseAmong(group){
  if(group.length===1){ sel=null; moves=[]; play(group[0]); return; }
  const back=document.createElement('div');
  back.className='mb on';
  const box=document.createElement('div');
  box.className='md';
  box.style.maxWidth='320px';
  box.innerHTML='<h3 style="margin-bottom:10px">Chọn cách đi</h3>';
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;gap:8px';
  group.forEach(m=>{
    const b=document.createElement('button');
    b.className='b p';
    b.style.textAlign='left';
    b.textContent=describeMove(m);
    b.onclick=ev=>{ev.stopPropagation();document.body.removeChild(back);sel=null;moves=[];play(m);};
    wrap.appendChild(b);
  });
  box.appendChild(wrap);
  back.appendChild(box);
  back.onclick=()=>{document.body.removeChild(back);};
  box.onclick=ev=>ev.stopPropagation();
  document.body.appendChild(back);
}

function tap(r,c){
  if(over)return;
  if(mode==="ai"&&turn!==human)return;
  if(sel){
    const group=moves.filter(x=>(x.tr??x.r)===r&&(x.tc??x.c)===c);
    if(group.length){sel=null;moves=[];chooseAmong(group);return;}
  }
  const p=at(r,c);
  if(p&&p.side===turn&&!(p.type==="SCH"&&!p.rider)){ sel={r,c}; moves=legalSafe(turn).filter(m=>m.from.r===r&&m.from.c===c); }
  else { sel=null; moves=[]; }
  draw();
}
stage.onclick=()=>{sel=null;moves=[];draw();};

/* ===== AI ===== */
const score=()=>{let s=0;for(const p of Object.values(bd)){let v=T[p.type].v+(p.hero?8:0);if(p.rider)v+=T[p.rider.type].v*.6;s+=(p.side==="RED"?1:-1)*v;}return s;};
function orderMoves(ms){
  // captures and trades first - lets alpha-beta cut off the (usually weaker) quiet moves sooner
  return ms.slice().sort((a,b)=>((b.cap?1:0)+(b.trade?1:0))-((a.cap?1:0)+(a.trade?1:0)));
}
function ab(d,side,al,be){
  if(!cmdOf("RED"))return -1e6-d;
  if(!cmdOf("BLUE"))return 1e6+d;
  if(d<=0)return score();
  const ms=orderMoves(legal(side)); if(!ms.length)return score();
  if(side==="RED"){let v=-Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.max(v,ab(d-1,"BLUE",al,be));bd=s;al=Math.max(al,v);if(al>=be)break;}return v;}
  let v=Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.min(v,ab(d-1,"RED",al,be));bd=s;be=Math.min(be,v);if(al>=be)break;}return v;
}
function sim(m){
  const fk=K(m.from.r,m.from.c),mv=bd[fk]; if(!mv)return;
  if(m.ride){const c2=at(m.r,m.c);c2.rider={type:mv.type,side:mv.side,hero:mv.hero};delete bd[fk];return;}
  if(m.stay){delete bd[K(m.tr,m.tc)];return;}
  if(m.off){const h=at(m.from.r,m.from.c),rd=h.rider;delete h.rider;if(m.cap)delete bd[K(m.r,m.c)];if(!m.trade)bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};return;}
  if(m.trade){delete bd[K(m.r,m.c)];delete bd[fk];return;}
  if(m.cap)delete bd[K(m.r,m.c)];
  delete bd[fk];
  const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
  if(mv.rider)np.rider=mv.rider;
  bd[K(m.r,m.c)]=np;
}
function aiTurn(){
  if(mode!=="ai"||over||turn===human)return;
  const ms=legalSafe(turn); if(!ms.length)return;
  let best=null,bs=turn==="RED"?-Infinity:Infinity;
  for(const m of orderMoves(ms).sort(()=>Math.random()-.3)){
    const s=cloneBoard(bd); sim(m);
    const v=ab(depth-1,turn==="RED"?"BLUE":"RED",-Infinity,Infinity)+Math.random()*.4;
    bd=s;
    if(turn==="RED"?v>bs:v<bs){bs=v;best=m;}
  }
  if(best)play(best);
}

/* ===== ui ===== */
let tt;
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>e.classList.remove('on'),2400);}
const $=id=>document.getElementById(id);
function reset(){setup();draw();if(mode==="ai"&&human==="BLUE")setTimeout(aiTurn,300);}
$('bNew').onclick=reset;
$('ovB').onclick=()=>{$('over').classList.remove('on');reset();};
$('bFlat').onclick=()=>{stage.classList.toggle('flat');draw();};
$('bRules').onclick=()=>$('rules').classList.add('on');
$('bClose').onclick=()=>$('rules').classList.remove('on');
$('bUndo').onclick=()=>{
  if(!history.length)return;
  let n=(mode==="ai"&&history.length>1)?2:1;
  let s; while(n-->0&&history.length)s=history.pop();
  bd=s.bd;turn=s.turn;log=s.log;lostR=s.lostR;lostB=s.lostB;last=s.last;
  over=false;sel=null;moves=[];warnSide=null;$('over').classList.remove('on');draw();
};
$('mLocal').onclick=()=>{mode="local";$('mLocal').classList.add('on');$('mAI').classList.remove('on');
  $('aiBox').style.display='none';$('modeTxt').textContent="2 người · 1 máy";reset();};
$('mAI').onclick=()=>{mode="ai";$('mAI').classList.add('on');$('mLocal').classList.remove('on');
  $('aiBox').style.display='flex';$('modeTxt').textContent="Đấu với máy";reset();};
$('lvl').onchange=e=>{depth=+e.target.value;};
$('sRed').onclick=()=>{human="RED";$('sRed').classList.add('on');$('sBlue').classList.remove('on');reset();};
$('sBlue').onclick=()=>{human="BLUE";$('sBlue').classList.add('on');$('sRed').classList.remove('on');reset();};

$('leg').innerHTML=Object.entries(T).map(([k,v])=>`<div><i>${ICON[k]}</i>${v.n}</div>`).join("");
$('ruleList').innerHTML=[
 ["CMD","đi ngang/dọc bao xa cũng được (không chéo), miễn không vướng vật cản; ăn quân chỉ trong phạm vi 1 đoạn. Có thể bước vào Sở chỉ huy của mình để ẩn náu (đứng lên trên), và rời đi bất cứ lúc nào."],
 ["SCH","đứng yên tuyệt đối, không tự đi/ăn quân, chỉ là vật cản. Chỉ Công binh, Xe tăng, Pháo binh, Không quân phá được. Nếu Tư lệnh đang ẩn trong đó mà bị phá, Tư lệnh bị diệt."],
 ["INF","đi/ăn ngang dọc 1 đoạn (tiến, lùi, sang ngang). Đứng tại chỗ bắn tàu chiến cách 1 đoạn (kể cả chéo) nếu tàu ở dưới nước. Bộ binh anh hùng ★ đi/ăn thêm cả đường chéo và xa thêm 1 đoạn."],
 ["ENG","như Bộ binh; đặc biệt chỉ Công binh mới cõng được khí tài nặng (Pháo binh, Cao xạ, Tên lửa) để vượt đoạn sông sâu. Công binh không cõng Tư lệnh, Bộ binh hay Dân quân."],
 ["AA","như Bộ binh; tạo vùng cấm bay bán kính 1 quanh nó. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["MIL","như Bộ binh nhưng đi/ăn/bắn tàu được cả 8 hướng kể cả chéo 45°."],
 ["TANK","đi/ăn ngang dọc 1–2 đoạn; đứng tại chỗ bắn tàu chiến trong tầm đó, không cần thế chỗ. Xe tăng anh hùng ★ đi/ăn/bắn thêm cả đường chéo."],
 ["SAM","đi/ăn quân mặt đất và trên không trong vành đai 2 đoạn (trục) / 1 đoạn (chéo). Không thể nhắm vào tàu chiến. Tạo vùng cấm bay lớn. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["ART","đi và ăn thẳng (ngang/dọc) 1–2 đoạn; đi và ăn chéo 45° 1 đoạn. Ăn quân bằng cách thế chỗ như quân thường. Đứng tại chỗ bắn được tàu chiến trong đúng tầm đó (thẳng 1–2, chéo 1). Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["AIR","bay 8 hướng 1–4 đoạn, vượt qua mọi vật cản. Ăn quân được chọn thế chỗ hoặc bay về chỗ cũ nếu thế chỗ không an toàn (riêng ăn máy bay địch bắt buộc thế chỗ). Không được hạ cánh xuống biển. Bay vào vùng cấm phòng không: nếu có mục tiêu ở đó thì cả hai cùng bị tiêu diệt (1 đổi 1); nếu ô trống thì coi như bị bắn rơi (không đi được). Có thể hạ cánh đậu trên Tàu chiến của mình. Không quân anh hùng ★ trở thành máy bay tàng hình: miễn nhiễm mọi hoả lực phòng không."],
 ["NAVY","tổ hợp 3 trong 1. Tự thân di chuyển thẳng/ngang/chéo tối đa 4 đoạn, bị chặn bởi vật cản đầu tiên trên đường đi (không bay qua được), chỉ trong dải biển và đoạn sông sâu tới chỗ ngầm gần nhất. Tên lửa hải đối hải: ăn tàu địch trong tầm đó, phải thế chỗ nếu đi thẳng tới được, nếu không (bị chắn) thì bắn tại chỗ. Pháo hạm: bắn mục tiêu trên bộ trong tầm 1–3 đoạn, luôn bắn tại chỗ (không thế chỗ). Cao xạ trên tàu tạo vùng cấm bay bán kính 1. Có thể chở Tư lệnh/Bộ binh/Dân quân hoặc làm tàu sân bay chở Không quân."],
].map(([k,d])=>`<li><b>${T[k].n}</b>: ${d}</li>`).join("");

(function buildSetupInfo(){
  const grid={};
  for(const [t,c,r] of RED_SETUP){ grid[r+","+c]=["RED",t]; grid[(ROWS-1-r)+","+c]=["BLUE",t]; }
  let h='<table class="smap"><tr><th></th>';
  for(let c=0;c<COLS;c++) h+='<th>'+c+'</th>';
  h+='</tr>';
  for(let r=ROWS-1;r>=0;r--){
    h+='<tr'+((r===RIVER_LO||r===RIVER_HI)?' class="rv"':'')+'><th>'+r+'</th>';
    for(let c=0;c<COLS;c++){
      const g=grid[r+","+c];
      const cls=(c<=SEA_MAX?'sea ':'')+(c===SHORE?'shore ':'');
      h+='<td class="'+cls+'">'+(g?'<span class="'+g[0]+'" title="'+T[g[1]].n+'">'+T[g[1]].c+'</span>':((r===RIVER_LO||r===RIVER_HI)&&FORDS.includes(c)?'<i>ngầm</i>':''))+'</td>';
    }
    h+='</tr>';
  }
  h+='</table>';
  $('setupMap').innerHTML=h;
  const byRow={};
  for(const [t,c,r] of RED_SETUP)(byRow[r]=byRow[r]||[]).push([c,t]);
  let l='';
  for(const r of Object.keys(byRow).map(Number).sort((a,b)=>a-b)){
    byRow[r].sort((a,b)=>a[0]-b[0]);
    l+='<li><b>Hàng '+r+'</b> (Xanh: hàng '+(ROWS-1-r)+'): '+byRow[r].map(([c,t])=>T[t].n+' (cột '+c+')').join(', ')+'</li>';
  }
  $('setupList').innerHTML=l;
})();
depth=+$('lvl').value;
setup();draw();
})();