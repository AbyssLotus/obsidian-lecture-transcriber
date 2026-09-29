class TFile { constructor(p){ this.path=p; const b=p.split('/').pop(); this.name=b;
  this.extension=b.includes('.')?b.split('.').pop():''; this.basename=b.replace(/\.[^.]+$/,'');
  const d=p.includes('/')?p.slice(0,p.lastIndexOf('/')):'/'; this.parent={path:d}; } }
class Plugin { constructor(){} addRibbonIcon(){} addCommand(){} addStatusBarItem(){return{setText(){},addClass(){},onclick:null};}
  addSettingTab(){} registerEvent(){} registerInterval(){} register(){} async loadData(){return {};} async saveData(){} }
class PluginSettingTab { constructor(app,plugin){this.app=app;this.plugin=plugin;} }
class Setting { constructor(){} setName(){return this;} setDesc(){return this;} setHeading(){return this;}
  addButton(){return this;} addToggle(){return this;} addText(){return this;} addTextArea(){return this;} addDropdown(){return this;} }
class Notice { constructor(){} }
class Modal { constructor(app){this.app=app;} open(){} close(){} }
let __resp=null;
async function requestUrl(o){
  if(__resp) return (typeof __resp==='function'?__resp(o):__resp);
  const r=await fetch(o.url,{method:o.method||'GET',headers:o.headers,body:o.body});
  const text=await r.text(); let json=null; try{json=JSON.parse(text);}catch(e){}
  return {status:r.status,text,json};
}
requestUrl.__set=(r)=>{__resp=r;};
module.exports = { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, requestUrl };
