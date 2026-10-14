import { LibraryError } from '../shared/library-store.mjs';
import { readJson,sendJson } from '../shared/http-json.mjs';
import { AccountError } from './account-store.mjs';
export function createLibraryHandler(store,sync){return async(req,res,url)=>{
  if(!url.pathname.startsWith('/api/library'))return false;
  try{
    if(req.method==='GET'&&url.pathname==='/api/library')sendJson(res,{...store.snapshot(),sync:sync.view(),serverTime:Math.round(Date.now()+(store.getMeta('clockOffset')||0))});
    else if(req.method==='GET'&&url.pathname==='/api/library/sync')sendJson(res,sync.view());
    else if(req.method==='POST'&&url.pathname==='/api/library/sync')sendJson(res,await sync.configure(await readJson(req),req.revalidateAccess));
    else if(req.method==='POST'&&url.pathname==='/api/library/operations')sendJson(res,{event:store.write(await readJson(req))});
    else if(req.method==='POST'&&url.pathname==='/api/library/import'){
      sendJson(res,store.importOperations(await readJson(req)));
    }else throw new LibraryError(404,'unknown library route');
  }catch(error){const full=error.errcode===13 || error.code==='SQLITE_FULL';const known=error instanceof LibraryError || error instanceof AccountError;sendJson(res,{error:full?'个人资料存储额度不足，请稍后重试':known?error.message:'本地资料保存失败'},full?507:known?error.status:500);}
  return true;
};}
