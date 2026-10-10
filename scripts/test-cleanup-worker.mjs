// Teste sem rede: Auth, RPC e Storage simulados.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const ok=(data=null)=>({data,error:null});
let handler,failRemove=false,failFinish=false,removes=0,finishes=0;
let batch={marked:1,retained:1,jobs:[]};
globalThis.__createClient=(_url,key,options)=>key==='service'?{
 storage:{from:bucket=>({remove:async paths=>{assert.equal(bucket,'menu-images');assert.deepEqual(paths,['tenant/products/item/file.webp']);removes++;return failRemove?{error:{message:'offline'}}:ok()}})},
 rpc:async(name,args)=>{assert.equal(name,'finish_menu_media_cleanup');assert.equal(args.p_id,'job');finishes++;return failFinish?{error:{message:'lost response'}}:ok()}
}:{auth:{getUser:async()=>({data:{user:{is_anonymous:options.global.headers.Authorization==='Bearer guest'}},error:null})},
 rpc:async(name)=>{assert.equal(name,'claim_unused_menu_media');return options.global.headers.Authorization==='Bearer admin'?ok(batch):{error:{code:'42501',message:'Sem acesso'}}}};
globalThis.Deno={env:{get:key=>({SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',ADMIN_ALLOWED_ORIGINS:'http://localhost:5173'})[key]},serve:fn=>{handler=fn}};
const src=(await readFile(new URL('../supabase/functions/cleanup-menu-media/index.ts',import.meta.url),'utf8')).replace('import { createClient } from "npm:@supabase/supabase-js@2.117.3";','const createClient = globalThis.__createClient;');
const js=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
async function call(token='admin',origin='http://localhost:5173'){
 const res=await handler(new Request('https://test.invalid',{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:origin},body:JSON.stringify({slug:'noma'})}));return {status:res.status,body:await res.json()};
}
assert.equal((await call('guest')).status,401);assert.equal((await call('waiter')).status,403);assert.equal((await call('admin','https://other.invalid')).status,403);
assert.equal((await call()).body.deleted,0);assert.equal(removes,0);
batch={marked:0,retained:0,jobs:[{id:'job',bucket:'menu-images',path:'tenant/products/item/file.webp'}]};
failRemove=true;assert.equal((await call()).body.failed,1);assert.equal(finishes,0);
failRemove=false;failFinish=true;assert.equal((await call()).body.failed,1);
failFinish=false;assert.equal((await call()).body.deleted,1);
console.log('PASS cleanup worker: authorization, origin, retention/no removal, Storage failure, completion failure and retry. No remote Supabase calls.');
