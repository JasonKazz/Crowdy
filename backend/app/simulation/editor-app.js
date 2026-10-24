'use strict';
const G=window.CrowdyGeometry, $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
const kinds=['furniture','walls','doors','exits','walkable_areas'];
const labels={furniture:'Furniture',walls:'Wall',doors:'Door',exits:'Exit',walkable_areas:'Floor'};
let layout=null,selected=null,preview=[],busy=false,drag=null,history=[],future=[],viewBox=null;
let providers={},calibrating=false,calibrationPoints=[];
let tool='move',spacePan=false,plannedRoutes=[],draftShape=null,fitWidth=null;
const layers=Object.fromEntries(kinds.map(kind=>[kind,{visible:true,locked:kind==='walkable_areas'}]));
const copy=value=>JSON.parse(JSON.stringify(value));
function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':'';}
function invalidate(){preview=[];plannedRoutes=[];$('downloads').replaceChildren();status('Edits have not been checked. Check layout or run the simulation.');}
function checkpoint(){history.push(copy(layout));if(history.length>100)history.shift();future=[];}
function editingView(){if(layout?.extraction)$('show-image').checked=false;}
function commit(action){checkpoint();action();editingView();invalidate();render();}
function item(){return selected?layout[selected.kind].find(x=>x.id===selected.id):null;}
function option(value,text){const el=document.createElement('option');el.value=value;el.textContent=text;return el;}
function select(kind,id){selected={kind,id};renderList();renderInspector();renderTools();draw();}
function svgElement(type,attrs,parent=$('plan')){
  const el=document.createElementNS(NS,type);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,String(value));
  parent.append(el);return el;
}
function polygon(points,fill,kind,id,stroke='#70829a'){
  const active=selected?.kind===kind&&selected.id===id;
  const el=svgElement('polygon',{points:points.map(([x,y])=>`${x},${-y}`).join(' '),fill,
    stroke:active?'#f59e0b':stroke,'stroke-width':active?0.08:0.035});
  if(kind&&layers[kind].visible){el.style.cursor=layers[kind].locked?'default':tool==='move'?'move':'pointer';el.addEventListener('pointerdown',e=>beginDrag(e,kind,id));}
  const title=svgElement('title',{},el);title.textContent=`${labels[kind]||''} ${id||''}`;
  return el;
}
function fit(){const points=layout.walkable_areas.flatMap(r=>r.polygon),source=layout.source_image;
  for(const exit of layout.exits)if(exit.floor_id){const geo=G.exitGeometry(exit,layout.walkable_areas);if(geo)points.push(...geo.apron);}
  if(source)points.push([0,0],[source.width_px*source.meters_per_pixel,source.height_px*source.meters_per_pixel]);
  const b=G.bounds(points);
  const margin=Math.max(1,(b.maxX-b.minX)*0.08,(b.maxY-b.minY)*0.08);
  viewBox=[b.minX-margin,-b.maxY-margin,b.maxX-b.minX+2*margin,b.maxY-b.minY+2*margin];fitWidth=viewBox[2];}
function draw(){
  if(!layout)return;$('plan').replaceChildren();$('plan').setAttribute('viewBox',viewBox.join(' '));
  $('zoom-label').textContent=`${Math.round(100*(fitWidth||viewBox[2])/viewBox[2])}%`;
  const source=layout.source_image,background=source&&$('show-image').checked;
  if($('grid').checked){const step=viewBox[2]>100?5:viewBox[2]<8?.5:1;
    for(let x=Math.ceil(viewBox[0]/step)*step;x<viewBox[0]+viewBox[2];x+=step)
      svgElement('line',{x1:x,y1:viewBox[1],x2:x,y2:viewBox[1]+viewBox[3],stroke:'#e0e7ef','stroke-width':.012,'pointer-events':'none'});
    for(let y=Math.ceil(viewBox[1]/step)*step;y<viewBox[1]+viewBox[3];y+=step)
      svgElement('line',{x1:viewBox[0],y1:y,x2:viewBox[0]+viewBox[2],y2:y,stroke:'#e0e7ef','stroke-width':.012,'pointer-events':'none'});
  }
  if(background){const width=source.width_px*source.meters_per_pixel,height=source.height_px*source.meters_per_pixel;
    svgElement('image',{href:`/images/${source.id}`,x:0,y:-height,width,height,'pointer-events':'none'});}
  for(const floor of layout.walkable_areas.filter(()=>layers.walkable_areas.visible)){const p=polygon(floor.polygon,'#e9f0fb','walkable_areas',floor.id,'#7187a4');
    if(background)p.setAttribute('fill-opacity','0.15');}
  for(const room of layout.rooms||[]){const[x,y]=G.center(room.polygon),text=svgElement('text',{
    x,y:-y,'font-size':Math.max(.15,viewBox[2]*.012),fill:'#1d4ed8','pointer-events':'none'});
    text.textContent=layout.room_labels?.[room.id]||room.id;}
  for(const f of layout.furniture.filter(()=>layers.furniture.visible)){const p=polygon(f.polygon,'#b7c2d2','furniture',f.id);if(background)p.setAttribute('fill-opacity','.5');}
  for(const wall of layout.walls.filter(()=>layers.walls.visible)){
    for(const points of G.wallPieces(wall,layout.doors))polygon(points,'#334155','walls',wall.id,'#1e293b');
    // A thin transparent centerline also lets users select very narrow walls.
    const line=svgElement('line',{x1:wall.start[0],y1:-wall.start[1],x2:wall.end[0],y2:-wall.end[1],
      stroke:'transparent','stroke-width':Math.max(.15,wall.thickness)});
    line.addEventListener('pointerdown',e=>beginDrag(e,'walls',wall.id));
  }
  for(const door of layout.doors.filter(()=>layers.doors.visible)){const wall=layout.walls.find(w=>w.id===door.wall_id);if(!wall)continue;
    polygon(G.wallPolygon(wall,door.offset-door.width/2,door.offset+door.width/2),'#b9e4ff','doors',door.id,'#2563eb');}
  const blocked=new Set(layout.settings.blocked_exit_ids||[]);
  for(const exit of layout.exits.filter(()=>layers.exits.visible)){const color=blocked.has(exit.id)?'#fecaca':'#b4efcf';
    if(!exit.floor_id){polygon(exit.polygon,color,'exits',exit.id);continue;}
    const geo=G.exitGeometry(exit,layout.walkable_areas);if(!geo)continue;
    const apron=polygon(geo.apron,'#f0fdf4',null,null,'#86a99a');apron.setAttribute('pointer-events','none');
    polygon(geo.target,color,'exits',exit.id);
    polygon(geo.threshold,color,'exits',exit.id,blocked.has(exit.id)?'#dc2626':'#059669');
  }
  for(const person of preview)svgElement('circle',{cx:person.position[0],cy:-person.position[1],
    r:layout.agent_defaults.radius,fill:'#335cce','pointer-events':'none'});
  if($('show-routes').checked)for(const route of plannedRoutes){
    svgElement('polyline',{points:route.path.map(([x,y])=>`${x},${-y}`).join(' '),fill:'none',stroke:'#7c3aed',
      'stroke-width':.035,'stroke-opacity':.45,'stroke-dasharray':'.12 .08','pointer-events':'none'});
  }
  if(draftShape){if(draftShape.polygon)polygon(draftShape.polygon,'#c7d8ff',null,null,'#335cce');
    else svgElement('line',{x1:draftShape.start[0],y1:-draftShape.start[1],x2:draftShape.end[0],y2:-draftShape.end[1],stroke:'#335cce','stroke-width':.2});}
  drawHandles();
  for(const[x,y]of calibrationPoints)svgElement('circle',{cx:x,cy:-y,r:Math.max(.07,viewBox[2]*.005),fill:'#dc2626','pointer-events':'none'});
}
function renderList(){
  const list=$('object-list');list.replaceChildren(option('','Choose an object'));
  for(const kind of kinds)for(const object of layout[kind]){
    const opt=option(JSON.stringify([kind,object.id]),`${labels[kind]} · ${object.id}`);
    opt.selected=selected?.kind===kind&&selected.id===object.id;list.append(opt);}
  const tree=$('object-tree');tree.replaceChildren();
  for(const kind of kinds)for(const object of layout[kind]){const b=document.createElement('button');
    b.textContent=`${layers[kind].locked?'🔒 ':''}${labels[kind]} · ${object.id}`;
    b.setAttribute('aria-pressed',String(selected?.kind===kind&&selected.id===object.id));
    b.addEventListener('click',()=>select(kind,object.id));tree.append(b);}
}
function field(parent,label,value,apply,step='0.1'){
  const box=document.createElement('label');box.append(document.createTextNode(label));
  const input=document.createElement('input');input.type='number';input.step=step;input.value=Number(value.toFixed(4));
  let previous=Number(input.value);
  const applyEdit=()=>{const number=Number(input.value);
    if(input.value===''||!Number.isFinite(number)){status('Enter a finite number.',true);return;}
    if(number===previous)return;previous=number;commit(()=>apply(number));};
  input.addEventListener('change',applyEdit);input.addEventListener('blur',applyEdit);
  box.append(input);parent.append(box);
}
function actionButton(parent,label,action){const b=document.createElement('button');b.textContent=label;
  b.addEventListener('click',()=>commit(action));parent.append(b);return b;}
function renderInspector(){
  const panel=$('inspector');panel.replaceChildren();const obj=item();if(!obj){panel.textContent='Select an object on the plan or in the list.';return;}
  const title=document.createElement('h2');title.textContent=obj.id;panel.append(title);
  if(layers[selected.kind].locked){const note=document.createElement('p');note.className='muted';
    note.textContent='This layer is locked. Unlock it under Layers & locks to edit its geometry.';panel.append(note);return;}
  if(selected.kind==='walls'){
    for(const endpoint of ['start','end'])for(const [axis,index]of [['x',0],['y',1]])
      field(panel,`${endpoint} ${axis}`,obj[endpoint][index],value=>obj[endpoint][index]=value);
    field(panel,'Thickness',obj.thickness,value=>obj.thickness=value);
    const note=document.createElement('p');note.className='muted';note.textContent='Drag to move the whole wall. Attached doors move with it.';panel.append(note);
  }else if(selected.kind==='doors'){
    const box=document.createElement('label');box.append(document.createTextNode('Parent wall'));
    const select=document.createElement('select');select.setAttribute('aria-label','Parent wall');for(const wall of layout.walls){const opt=option(wall.id,wall.id);opt.selected=wall.id===obj.wall_id;select.append(opt);}
    select.addEventListener('change',()=>commit(()=>obj.wall_id=select.value));box.append(select);panel.append(box);
    field(panel,'Center distance from wall start',obj.offset,value=>obj.offset=value);
    field(panel,'Opening width',obj.width,value=>obj.width=value);
  }else if(selected.kind==='exits'&&obj.floor_id){
    const box=document.createElement('label');box.append(document.createTextNode('Exterior boundary edge'));
    const edges=document.createElement('select');edges.setAttribute('aria-label','Exterior boundary edge');
    for(const floor of layout.walkable_areas)for(const[index,start]of floor.polygon.entries()){
      const end=floor.polygon[(index+1)%floor.polygon.length];
      const opt=option(JSON.stringify([floor.id,index]),`${floor.id} edge ${index}: (${start.map(n=>n.toFixed(1))}) → (${end.map(n=>n.toFixed(1))})`);
      opt.selected=obj.floor_id===floor.id&&obj.edge_index===index;edges.append(opt);}
    edges.addEventListener('change',()=>commit(()=>{[obj.floor_id,obj.edge_index]=JSON.parse(edges.value);
      const geo=G.exitGeometry(obj,layout.walkable_areas);if(geo)obj.offset=G.wallLength(geo.wall)/2;fit();}));
    box.append(edges);panel.append(box);
    field(panel,'Center distance from edge start',obj.offset,value=>{obj.offset=value;fit();});
    field(panel,'Opening width',obj.width,value=>{obj.width=value;fit();});
    const outside=document.createElement('label');outside.append(document.createTextNode('Space outside the door'));
    const mode=document.createElement('select');mode.setAttribute('aria-label','Space outside the door');for(const [value,label]of [['open','Open area — people can disperse'],['corridor','Corridor — constrained width']]){
      const opt=option(value,label);opt.selected=(obj.outside_space||'open')===value;mode.append(opt);}
    mode.addEventListener('change',()=>commit(()=>{obj.outside_space=mode.value;fit();}));outside.append(mode);panel.append(outside);
    field(panel,'Outside distance',obj.landing_depth,value=>{obj.landing_depth=value;fit();});
    if((obj.outside_space||'open')==='open')field(panel,'Open area width at far edge',obj.outside_width||obj.width+2*obj.landing_depth,
      value=>{obj.outside_width=value;fit();});
  }else{
    const b=G.bounds(obj.polygon),[cx,cy]=G.center(obj.polygon);
    field(panel,'Center x',cx,value=>obj.polygon=G.translate(obj.polygon,value-cx,0));
    field(panel,'Center y',cy,value=>obj.polygon=G.translate(obj.polygon,0,value-cy));
    field(panel,'Width (bounding box)',b.maxX-b.minX,value=>{if(value>0)obj.polygon=G.resize(obj.polygon,value,b.maxY-b.minY);});
    field(panel,'Height (bounding box)',b.maxY-b.minY,value=>{if(value>0)obj.polygon=G.resize(obj.polygon,b.maxX-b.minX,value);});
    const row=document.createElement('div');row.className='row';panel.append(row);
    actionButton(row,'Rotate −15°',()=>obj.polygon=G.rotate(obj.polygon,-15));
    actionButton(row,'Rotate +15°',()=>obj.polygon=G.rotate(obj.polygon,15));
  }
    if(selected.kind==='exits'){
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';
      check.checked=(layout.settings.blocked_exit_ids||[]).includes(obj.id);
      check.addEventListener('change',()=>commit(()=>{const ids=new Set(layout.settings.blocked_exit_ids||[]);
        if(check.checked)ids.add(obj.id);else ids.delete(obj.id);layout.settings.blocked_exit_ids=[...ids];}));
      label.append(check,document.createTextNode(' Block this exit'));panel.append(label);}
  const remove=document.createElement('button');remove.textContent=selected.kind==='walls'?'Remove wall and its doors':'Remove object';
  remove.disabled=selected.kind==='walkable_areas'&&layout.walkable_areas.length===1;
  remove.addEventListener('click',()=>commit(()=>{const {kind,id}=selected;layout[kind]=layout[kind].filter(o=>o.id!==id);
    if(kind==='walls')layout.doors=layout.doors.filter(d=>d.wall_id!==id);
    if(kind==='exits')layout.settings.blocked_exit_ids=(layout.settings.blocked_exit_ids||[]).filter(e=>e!==id);selected=null;}));panel.append(remove);
}
function render(){
  renderTools();renderLayers();renderList();renderInspector();draw();$('people').value=layout.population?.count??layout.occupants.length;
  $('seed').value=layout.population?.seed??42;$('people').disabled=!layout.population;$('seed').disabled=!layout.population;
  $('speed').value=layout.agent_defaults.desired_speed;$('max-time').value=layout.settings.max_time;
  $('population-note').textContent=layout.population?'Population will be regenerated within the selected spawn areas after edits. A fixed seed repeats placement only for unchanged geometry.':
    'Imported manual people stay at their original positions. Checks reject edits that overlap them.';
  $('undo').disabled=history.length===0;$('redo').disabled=future.length===0;
  renderImageControls();
}
function pointer(event){const p=new DOMPoint(event.clientX,event.clientY).matrixTransform($('plan').getScreenCTM().inverse());return[p.x,-p.y];}
function snapped(value){return $('snap').checked?Math.round(value*10)/10:value;}
function beginDrag(event,kind,id,handle){
  if(busy||calibrating||event.button!==0||spacePan||tool==='pan'||tool.startsWith('draw-')||tool.startsWith('place-'))return;
  event.preventDefault();event.stopPropagation();select(kind,id);
  if(layers[kind].locked){status('This layer is locked. Unlock it under Layers & locks to edit.');return;}
  if(tool!=='move'&&!handle)return;
  editingView();drag={kind,id,handle,start:pointer(event),original:copy(item()),before:copy(layout),
    previousFuture:future,pointerId:event.pointerId,moved:false};draw();$('plan').setPointerCapture(event.pointerId);
}
$('plan').addEventListener('pointermove',event=>{
  if(!drag||event.pointerId!==drag.pointerId)return;
  if(drag.pan){const rect=$('plan').getBoundingClientRect(),ratio=Math.min(rect.width/drag.box[2],rect.height/drag.box[3]);
    viewBox=[drag.box[0]-(event.clientX-drag.client[0])/ratio,drag.box[1]-(event.clientY-drag.client[1])/ratio,...drag.box.slice(2)];draw();return;}
  const p=pointer(event).map(snapped),dx=snapped(p[0]-drag.start[0]),dy=snapped(p[1]-drag.start[1]);
  if(drag.drawing){draftShape=drag.drawing==='furniture'?{polygon:rectangle(drag.start,p)}:{start:drag.start,end:p};draw();return;}
  if(!drag.moved&&Math.hypot(dx,dy)<.005)return;
  if(!drag.moved){history.push(drag.before);future=[];drag.moved=true;}
  const obj=item(),original=drag.original,handle=drag.handle;
  if(handle?.type==='vertex'){obj.polygon=copy(original.polygon);obj.polygon[handle.index]=p;}
  else if(handle?.type==='resize')obj.polygon=G.resizeCorner(original.polygon,handle.index,p,event.shiftKey);
  else if(handle?.type==='endpoint')obj[handle.endpoint]=p;
  else if(handle?.type==='rotate'){
    const points=original.polygon||[original.start,original.end],[cx,cy]=G.center(points);
    let angle=(Math.atan2(p[1]-cy,p[0]-cx)-Math.atan2(drag.start[1]-cy,drag.start[0]-cx))*180/Math.PI;
    if(event.shiftKey)angle=Math.round(angle/15)*15;
    const rotated=G.rotate(points,angle);if(original.polygon)obj.polygon=rotated;else[obj.start,obj.end]=rotated;
  }else if(handle?.type==='door-size'){
    const wall=drag.kind==='doors'?layout.walls.find(w=>w.id===obj.wall_id):G.exitGeometry(obj,layout.walkable_areas)?.wall;
    if(wall){const length=G.wallLength(wall),offset=G.doorOffset(wall,{width:.1,offset:obj.offset},p);
      const fixed=original.offset+(handle.side==='start'?1:-1)*original.width/2;
      obj.width=Math.max(.1,Math.abs(fixed-offset));obj.offset=(fixed+offset)/2;}
  }else if(drag.kind==='walls'){obj.start=G.translate([original.start],dx,dy)[0];obj.end=G.translate([original.end],dx,dy)[0];}
  else if(drag.kind==='doors'){
    const oldWall=layout.walls.find(w=>w.id===original.wall_id),point=G.center(G.wallPolygon(oldWall,original.offset-.01,original.offset+.01));
    const attached=nearestWall([point[0]+dx,point[1]+dy],obj.width);if(attached){obj.wall_id=attached.wall.id;obj.offset=attached.offset;}
  }else if(drag.kind==='exits'&&obj.floor_id){
    const geo=G.exitGeometry(original,layout.walkable_areas),point=G.center(geo.threshold);
    const attached=G.nearestEdge(layout.walkable_areas,[point[0]+dx,point[1]+dy],obj.width);
    if(attached){obj.floor_id=attached.floor_id;obj.edge_index=attached.edge_index;obj.offset=attached.offset;}
  }else obj.polygon=G.translate(original.polygon,dx,dy);
  invalidate();draw();
});
function finishDrag(){
  if(!drag)return;
  if(drag.drawing){const shape=draftShape,kind=drag.drawing;drag=null;draftShape=null;
    if(shape&&(kind==='furniture'?Math.abs(polygonArea(shape.polygon))>.04:G.wallLength(shape)>.1))
      commit(()=>{const id=newId(kind);layout[kind].push({id,...shape,...(kind==='walls'?{thickness:.2}:{})});selected={kind,id};});
    else render();return;}
  drag=null;render();
}
$('plan').addEventListener('pointerup',finishDrag);
$('plan').addEventListener('pointercancel',()=>cancelDrag());
$('object-list').addEventListener('change',()=>{if(!$('object-list').value){selected=null;render();return;}
  const[kind,id]=JSON.parse($('object-list').value);select(kind,id);});
function undo(){if(!history.length)return;future.push(copy(layout));layout=history.pop();selected=null;invalidate();render();}
function redo(){if(!future.length)return;history.push(copy(layout));layout=future.pop();selected=null;invalidate();render();}
$('undo').addEventListener('click',undo);$('redo').addEventListener('click',redo);
for(const [id,apply]of Object.entries({people:n=>layout.population.count=n,seed:n=>layout.population.seed=n,
  speed:n=>layout.agent_defaults.desired_speed=n,'max-time':n=>layout.settings.max_time=n})){
  const current=()=>({people:layout.population?.count,seed:layout.population?.seed,
    speed:layout.agent_defaults.desired_speed,'max-time':layout.settings.max_time})[id];
  const applyEdit=()=>{const n=Number($(id).value);
    if($(id).value===''||!Number.isFinite(n)||n===current())return;commit(()=>apply(n));};
  $(id).addEventListener('change',applyEdit);$(id).addEventListener('blur',applyEdit);}
function newId(kind){let i=1;while(layout[kind].some(o=>o.id===`${kind}-${i}`))i++;return`${kind}-${i}`;}
$('add').addEventListener('click',()=>{
  const kind=$('add-kind').value;
  setTool({furniture:'draw-furniture',walls:'draw-wall',doors:'place-door',exits:'place-exit'}[kind]);
});
function download(name,document){const url=URL.createObjectURL(new Blob([JSON.stringify(document,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export').addEventListener('click',()=>download('crowdy-layout.json',layout));
function setBusy(value){busy=value;document.querySelectorAll('button,input,select').forEach(el=>el.disabled=value);if(!value&&layout)render();}
async function post(path,document){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(document)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');return result;}
$('import').addEventListener('click',()=>$('file').click());
$('file').addEventListener('change',async()=>{const file=$('file').files[0];if(!file)return;setBusy(true);
  try{const next=await post('/api/import',JSON.parse(await file.text()));checkpoint();layout=next;
    $('show-image').checked=Boolean(layout.source_image&&!layout.extraction);selected=null;viewBox=null;fit();invalidate();}
  catch(error){status(error.message,true);}finally{$('file').value='';setBusy(false);}});
$('validate').addEventListener('click',async()=>{setBusy(true);status('Checking geometry and placing people…');
  try{const result=await post('/api/validate',layout);preview=result.occupants;plannedRoutes=result.routes||[];
    status(`Layout passed checks · ${result.area_m2.toFixed(1)} m² walkable · ${preview.length} starting people.`);}
  catch(error){preview=[];status(error.message,true);}finally{setBusy(false);}});
$('run').addEventListener('click',async()=>{setBusy(true);status('Running the backend simulation…');$('downloads').replaceChildren();
  try{const result=await post('/api/simulate',layout),s=result.summary;
    status(`${result.status==='completed'?'Completed':'Time limit reached'} · ${s.evacuated_count} exited · ${s.remaining_count} remaining · `+
      (s.clearance_time===null?'Evacuation incomplete':`${s.clearance_time.toFixed(2)} s to clear exterior`)+
      (s.building_clearance_time==null?'':` · Building empty at ${s.building_clearance_time.toFixed(2)} s`));
    for(const [name,path]of [['Open animation',result.playback_url],['Layout JSON',`/runs/${result.run_id}/layout`],
      ['Scenario JSON',`/runs/${result.run_id}/scenario`],['Result JSON',`/runs/${result.run_id}/result`]]){
      const a=document.createElement('a');a.textContent=name;a.href=path;a.target='_blank';a.rel='noopener';$('downloads').append(a);}}
  catch(error){status(error.message,true);}finally{setBusy(false);}});
function renderImageControls(){
  const source=layout.source_image;
  $('extract-image').disabled=busy||!source||!providers[$('provider').value]?.configured;
  $('compare-image').disabled=busy||!source||!providers.gemini?.configured||!providers.claude?.configured;
  $('calibrate').disabled=busy||!source;$('calibrate').textContent=calibrating?'Cancel marking':'Mark two points to set scale';
  $('provider-status').textContent=['gemini','claude'].map(name=>{
    const info=providers[name];return `${name==='gemini'?'Gemini':'Claude'}: ${info?.configured?'configured':'key missing in root .env'}${info?.model?' · '+info.model:''}`;
  }).join('    |    ');
  $('image-note').textContent=source?
    `${source.width_px} × ${source.height_px} pixels · ${source.scale_confirmed?'Scale set':'Scale unconfirmed — mark a known distance before simulation'}. `+
    (layout.extraction?`Showing ${layout.extraction.provider} extraction. The original image is a fixed reference; its printed furniture and door swings do not move. Toggle comparison to check alignment.`:
      'The rectangle is only an image frame. Extract the actual building layout before running.'):
    'Upload PNG, JPEG, or WebP. Set scale using a distance you know, then extract with either provider or compare both. Extraction sends the image to the selected provider.';
}
$('provider').addEventListener('change',renderImageControls);
$('show-image').addEventListener('change',draw);
$('upload-image').addEventListener('click',()=>$('image-file').click());
function readImage(file){return new Promise((resolve,reject)=>{const reader=new FileReader();
  reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read this image.'));reader.readAsDataURL(file);});}
$('image-file').addEventListener('change',async()=>{
  const file=$('image-file').files[0];if(!file)return;
  if(file.size>10*1024*1024){status('Choose an image up to 10 MiB.',true);$('image-file').value='';return;}
  setBusy(true);status('Preparing your floor plan image…');
  try{const result=await post('/api/images',{filename:file.name,image_base64:await readImage(file)});
    checkpoint();layout=result.layout;$('show-image').checked=true;selected=null;calibrating=false;calibrationPoints=[];invalidate();fit();
    $('candidates').replaceChildren();status('Image ready. Mark a known distance, then extract the layout.');
  }catch(error){status(error.message,true);}finally{$('image-file').value='';setBusy(false);}
});
$('calibrate').addEventListener('click',()=>{
  if(!layout.source_image)return;calibrating=!calibrating;calibrationPoints=[];if(calibrating)$('show-image').checked=true;
  status(calibrating?'Click the two ends of a known distance on the image. Enter its real length in Known distance (m).':'Scale marking canceled.');
  renderImageControls();draw();
});
$('plan').addEventListener('pointerdown',event=>{
  if(busy||!calibrating||event.button!==0)return;event.preventDefault();calibrationPoints.push(pointer(event));
  if(calibrationPoints.length<2){status('Now click the other end of the known distance.');draw();return;}
  const known=Number($('known-distance').value),distance=Math.hypot(
    calibrationPoints[1][0]-calibrationPoints[0][0],calibrationPoints[1][1]-calibrationPoints[0][1]);
  if(!Number.isFinite(known)||known<=0||distance<1e-6){
    calibrationPoints=[];status('Enter a positive real distance and choose two different points.',true);draw();return;}
  checkpoint();layout=window.CrowdyImageTools.rescaleLayout(layout,known/distance);
  calibrating=false;calibrationPoints=[];editingView();invalidate();fit();render();status(`Scale set: the marked distance is ${known} meters.`);
});
function useCandidate(candidate){
  checkpoint();let next=copy(candidate.layout);
  if(layout.source_image?.id===next.source_image?.id&&layout.source_image.scale_confirmed){
    next=window.CrowdyImageTools.rescaleLayout(next,layout.source_image.meters_per_pixel/next.source_image.meters_per_pixel);}
  layout=next;$('show-image').checked=false;selected=null;calibrating=false;calibrationPoints=[];invalidate();fit();render();
  status(`${candidate.provider} layout loaded. Edit the geometry, or toggle image comparison to check alignment before running.`+
    (candidate.issues.length?'\nNeeds attention: '+candidate.issues.join('\n'):''));
}
function showCandidates(results){
  $('candidates').replaceChildren();
  for(const candidate of results){
    const card=document.createElement('div');card.className='candidate';
    const title=document.createElement('strong');title.textContent=candidate.provider==='gemini'?'Gemini':'Claude';card.append(title);
    const text=document.createElement('p');card.append(text);
    if(candidate.error){text.textContent=candidate.error;$('candidates').append(card);continue;}
    text.textContent=`${candidate.model} · ${candidate.elapsed_seconds.toFixed(1)} s\n`+
      Object.entries(candidate.counts).map(([name,count])=>`${count} ${name}`).join(' · ')+
      (candidate.warnings.length?'\nModel notes: '+candidate.warnings.join('\n'):'')+
      (candidate.issues.length?'\nGeometry checks: '+candidate.issues.join('\n'):'\nGeometry checks passed; review alignment against the image.');
    const button=document.createElement('button');button.textContent=`Use ${title.textContent} layout`;
    button.addEventListener('click',()=>useCandidate(candidate));card.append(button);$('candidates').append(card);
  }
}
async function extract(provider){
  if(!layout.source_image)return;setBusy(true);
  status(provider==='both'?'Extracting with Gemini and Claude. Each provider receives the same image; this may take a few minutes.':
    `Extracting with ${provider}. This may take a few minutes.`);
  try{const source=layout.source_image,result=await post('/api/extract',{
      image_id:source.id,provider,meters_per_pixel:source.meters_per_pixel,
      scale_confirmed:source.scale_confirmed,people_count:layout.population?.count||layout.occupants.length||40});
    showCandidates(result.results);
    if(!result.results.some(candidate=>candidate.layout))status('No layout was extracted. See the provider errors below.',true);
    else if(provider!=='both'&&result.results[0]?.layout)useCandidate(result.results[0]);
    else status('Extraction finished. Compare the notes and choose a layout to inspect.');
  }catch(error){status(error.message,true);}finally{setBusy(false);}
}
$('extract-image').addEventListener('click',()=>extract($('provider').value));
$('compare-image').addEventListener('click',()=>extract('both'));
async function init(){
  setBusy(true);
  if(location.protocol==='file:'){
    status('This editor needs its Python server. Opening editor.html directly cannot load layouts, import JSON, or run simulations.\n\n'+
      'From your repo’s backend folder, run:\npython -m app.simulation.editor\n\n'+
      'Then open http://127.0.0.1:8765 in your browser. Keep the terminal running. '+
      'If you used --port 8766, open http://127.0.0.1:8766 instead.',true);
    return;
  }
  try{
    if(!G)throw new Error('Could not load the drawing tools.');
    const [response,configuration]=await Promise.all([fetch('/api/layout'),fetch('/api/providers')]);
    if(!response.ok||!configuration.ok)throw new Error('Could not load the editor. Restart the Python server after updating.');
    layout=await response.json();providers=await configuration.json();$('show-image').checked=Boolean(layout.source_image&&!layout.extraction);fit();setBusy(false);
    status('Select and move an object, or check the layout to preview starting people.');
  }catch(error){status(`${error.message}\nKeep the Python editor server running and open the http:// address printed in its terminal.`,true);}
}
function rectangle(a,b){return[[Math.min(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.min(a[1],b[1])],
  [Math.max(a[0],b[0]),Math.max(a[1],b[1])],[Math.min(a[0],b[0]),Math.max(a[1],b[1])]];}
function polygonArea(points){return points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0)/2;}
function nearestWall(point,width){
  return layout.walls.filter(w=>G.wallLength(w)>=width).map(wall=>{
    const offset=G.doorOffset(wall,{width,offset:0},point),length=G.wallLength(wall);
    const center=[wall.start[0]+(wall.end[0]-wall.start[0])*offset/length,wall.start[1]+(wall.end[1]-wall.start[1])*offset/length];
    return{wall,offset,distance:Math.hypot(point[0]-center[0],point[1]-center[1])};
  }).sort((a,b)=>a.distance-b.distance)[0];
}
function setTool(next){if(busy)return;cancelDrag();tool=next;renderTools();draw();}
function renderTools(){
  document.querySelectorAll('[data-tool]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tool===tool)));
  const hints={move:'Drag to move a whole object. Doors attach to the nearest wall or boundary. Arrow keys nudge; Shift moves 1 m.',
    resize:'Drag a square handle to resize the whole shape. Hold Shift to preserve proportions. Door handles change opening width.',
    rotate:'Drag the round rotation handle. Hold Shift to snap to 15°.',vertices:'Drag individual corner points. This can change a rectangle into an irregular polygon.',
    pan:'Drag the canvas to pan. Scroll to zoom, or choose Fit view.',
    'draw-furniture':'Drag a rectangle on the floor to draw furniture. Escape cancels.',
    'draw-wall':'Drag from the start to the end of a new wall. Escape cancels.',
    'place-door':'Click near an interior wall to place a 1.2 m door opening.',
    'place-exit':'Click near the building boundary to place an exterior exit into open space.'};
  $('tool-hint').textContent=hints[tool];$('plan').style.cursor=spacePan||tool==='pan'?'grab':tool.startsWith('draw-')||tool.startsWith('place-')?'crosshair':'default';
  $('delete').disabled=busy||!item()||layers[selected?.kind]?.locked;
  $('duplicate').disabled=busy||!item()||!['furniture','walls'].includes(selected?.kind)||layers[selected?.kind]?.locked;
}
function renderLayers(){
  const panel=$('layers');panel.replaceChildren();
  for(const kind of kinds){const row=document.createElement('label'),name=document.createElement('span');name.textContent=labels[kind];row.append(name);
    for(const [property,label]of [['visible','Show'],['locked','Lock']]){const box=document.createElement('span'),input=document.createElement('input');
      input.type='checkbox';input.checked=layers[kind][property];input.setAttribute('aria-label',`${label} ${labels[kind]} layer`);
      input.addEventListener('change',()=>{layers[kind][property]=input.checked;render();});box.append(input,document.createTextNode(' '+label));row.append(box);}
    panel.append(row);}
}
function drawHandles(){
  const obj=item();if(!obj||calibrating||!layers[selected.kind].visible||layers[selected.kind].locked)return;
  const radius=Math.max(.06,viewBox[2]*.005);
  function handle(point,details,square=false){
    const[x,y]=point,el=svgElement(square?'rect':'circle',square?
      {x:x-radius,y:-y-radius,width:radius*2,height:radius*2,fill:'white',stroke:'#335cce','stroke-width':.04}:
      {cx:x,cy:-y,r:radius,fill:details.type==='rotate'?'#335cce':'white',stroke:'#335cce','stroke-width':.04});
    el.style.cursor=details.type==='rotate'?'grab':details.type==='vertex'?'crosshair':'nwse-resize';
    el.addEventListener('pointerdown',e=>beginDrag(e,selected.kind,selected.id,details));
  }
  if(obj.polygon){const b=G.bounds(obj.polygon),corners=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]];
    if(tool==='resize')corners.forEach((point,index)=>handle(point,{type:'resize',index},true));
    if(tool==='vertices')obj.polygon.forEach((point,index)=>handle(point,{type:'vertex',index}));
  }
  if(selected.kind==='walls'&&['resize','vertices'].includes(tool))
    for(const endpoint of ['start','end'])handle(obj[endpoint],{type:'endpoint',endpoint},true);
  if(['doors','exits'].includes(selected.kind)&&!obj.polygon&&tool==='resize'){
    const wall=selected.kind==='doors'?layout.walls.find(w=>w.id===obj.wall_id):G.exitGeometry(obj,layout.walkable_areas)?.wall;
    if(wall){const length=G.wallLength(wall);for(const side of ['start','end']){
      const along=obj.offset+(side==='start'?-1:1)*obj.width/2;
      handle([wall.start[0]+(wall.end[0]-wall.start[0])*along/length,wall.start[1]+(wall.end[1]-wall.start[1])*along/length],{type:'door-size',side},true);}}
  }
  if(tool==='rotate'&&(obj.polygon||selected.kind==='walls')){
    const points=obj.polygon||[obj.start,obj.end],b=G.bounds(points),[cx,cy]=G.center(points),y=b.maxY+viewBox[2]*.04;
    svgElement('line',{x1:cx,y1:-cy,x2:cx,y2:-y,stroke:'#335cce','stroke-width':.025,'stroke-dasharray':'.1 .08','pointer-events':'none'});
    handle([cx,y],{type:'rotate'});
  }
}
function cancelDrag(){
  if(drag?.moved){layout=drag.before;history.pop();future=drag.previousFuture;}
  drag=null;draftShape=null;if(layout)render();
}
function removeSelected(){
  if(!item()||layers[selected.kind].locked)return;
  if(selected.kind==='walkable_areas'&&layout.walkable_areas.length===1){status('Keep at least one floor polygon.',true);return;}
  commit(()=>{const{kind,id}=selected;layout[kind]=layout[kind].filter(obj=>obj.id!==id);
    if(kind==='walls')layout.doors=layout.doors.filter(door=>door.wall_id!==id);
    if(kind==='exits')layout.settings.blocked_exit_ids=(layout.settings.blocked_exit_ids||[]).filter(exit=>exit!==id);selected=null;});
}
function duplicateSelected(){
  const obj=item(),kind=selected?.kind;if(!obj||layers[kind].locked||!['furniture','walls'].includes(kind))return;
  commit(()=>{const next=copy(obj);next.id=newId(kind);
    if(next.polygon)next.polygon=G.translate(next.polygon,.5,-.5);
    else{next.start=G.translate([next.start],.5,-.5)[0];next.end=G.translate([next.end],.5,-.5)[0];
      for(const door of [...layout.doors].filter(d=>d.wall_id===obj.id))layout.doors.push({...copy(door),id:newId('doors'),wall_id:next.id});}
    layout[kind].push(next);selected={kind,id:next.id};});
}
$('delete').addEventListener('click',removeSelected);$('duplicate').addEventListener('click',duplicateSelected);
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
function zoom(factor,anchor){if(!layout||viewBox[2]*factor<1||viewBox[2]*factor>2000)return;viewBox=G.zoomBox(viewBox,factor,anchor);draw();}
$('zoom-in').addEventListener('click',()=>zoom(.8));$('zoom-out').addEventListener('click',()=>zoom(1.25));
$('fit-view').addEventListener('click',()=>{fit();draw();});
$('grid').addEventListener('change',draw);$('show-routes').addEventListener('change',draw);
$('plan').addEventListener('wheel',event=>{if(busy||!layout)return;event.preventDefault();const p=pointer(event);zoom(Math.exp(Math.max(-.4,Math.min(.4,event.deltaY*.001))),[p[0],-p[1]]);},{passive:false});
$('plan').addEventListener('pointerdown',event=>{
  if(busy||calibrating||!layout)return;
  if(spacePan||tool==='pan'||event.button===1){event.preventDefault();drag={pan:true,client:[event.clientX,event.clientY],box:[...viewBox],pointerId:event.pointerId};
    $('plan').setPointerCapture(event.pointerId);return;}
  if(event.button!==0)return;
  const point=pointer(event).map(snapped);
  if(tool.startsWith('draw-')){event.preventDefault();drag={drawing:tool==='draw-wall'?'walls':'furniture',start:point,pointerId:event.pointerId};
    $('plan').setPointerCapture(event.pointerId);return;}
  if(tool==='place-door'){
    const attached=nearestWall(point,1.2);if(!attached){status('Draw an interior wall first.',true);return;}
    commit(()=>{const id=newId('doors');layout.doors.push({id,wall_id:attached.wall.id,offset:attached.offset,width:1.2});selected={kind:'doors',id};});setTool('move');return;
  }
  if(tool==='place-exit'){
    const attached=G.nearestEdge(layout.walkable_areas,point,1.2);if(!attached){status('No floor edge is wide enough for this door.',true);return;}
    commit(()=>{const id=newId('exits');layout.exits.push({id,floor_id:attached.floor_id,edge_index:attached.edge_index,offset:attached.offset,width:1.2,
      landing_depth:2,outside_space:'open',outside_width:null});selected={kind:'exits',id};fit();});setTool('move');return;
  }
  if(event.target===$('plan')){selected=null;render();}
});
document.addEventListener('keydown',event=>{
  if(busy||['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)||event.target.isContentEditable)return;
  const key=event.key.toLowerCase();
  if((event.ctrlKey||event.metaKey)&&key==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if((event.ctrlKey||event.metaKey)&&key==='d'){event.preventDefault();duplicateSelected();return;}
  if(key==='escape'){event.preventDefault();cancelDrag();setTool('move');return;}
  if(key===' '){event.preventDefault();spacePan=true;renderTools();return;}
  if(key==='delete'||key==='backspace'){event.preventDefault();removeSelected();return;}
  const tools={v:'move',s:'resize',r:'rotate',e:'vertices',h:'pan',f:'draw-furniture',w:'draw-wall',d:'place-door',x:'place-exit'};
  if(tools[key]){event.preventDefault();setTool(tools[key]);return;}
  if(!['arrowleft','arrowright','arrowup','arrowdown'].includes(key)||!item()||layers[selected.kind].locked)return;
  event.preventDefault();const delta=event.shiftKey?1:.1,dx=key==='arrowleft'?-delta:key==='arrowright'?delta:0,dy=key==='arrowdown'?-delta:key==='arrowup'?delta:0;
  commit(()=>{const obj=item();if(obj.polygon)obj.polygon=G.translate(obj.polygon,dx,dy);
    else if(selected.kind==='walls'){obj.start=G.translate([obj.start],dx,dy)[0];obj.end=G.translate([obj.end],dx,dy)[0];}
    else{const wall=selected.kind==='doors'?layout.walls.find(w=>w.id===obj.wall_id):G.exitGeometry(obj,layout.walkable_areas)?.wall;
      if(wall){const point=G.center(G.wallPolygon(wall,obj.offset-.01,obj.offset+.01));obj.offset=G.doorOffset(wall,obj,[point[0]+dx,point[1]+dy]);}}});
});
document.addEventListener('keyup',event=>{if(event.key===' '){spacePan=false;renderTools();}});

init();
