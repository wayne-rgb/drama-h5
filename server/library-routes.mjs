import { LibraryError } from '../shared/library-store.mjs';
import { readJson,sendJson } from '../shared/http-json.mjs';
import { AccountError } from './account-store.mjs';
export function createLibraryHandler(store,sync){return async(req,res,url)=>{
  if(!url.pathname.startsWith('/api/library'))return false;
  try{
    if(req.method==='GET'&&url.pathname==='/api/library'){
      if(url.searchParams.has('seriesId'))sendJson(res,{item:store.record('history',url.searchParams.get('seriesId')),favorite:store.record('favorite',url.searchParams.get('seriesId'))});
      else if(url.searchParams.has('kind'))sendJson(res,store.listPage(url.searchParams.get('kind'),{cursor:url.searchParams.get('cursor')||'',limit:Number(url.searchParams.get('limit')||50)}));
      else{
        const revision=store.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM library_events').get().revision;
        const version=`${store.readInstance}:${revision}:${store.mutations}`,since=Number(url.searchParams.get('since')||0);
        if(!Number.isSafeInteger(since)||since<0)throw new LibraryError(400,'资料版本无效');
        const state={sync:sync.view(),serverTime:Math.round(Date.now()+(store.getMeta('clockOffset')||0)),revision,version};
        if(url.searchParams.get('version')===version)sendJson(res,{...state,unchanged:true});
        else{
          const delta=store.db.prepare("SELECT kind,item_key AS key,json_extract(event_json,'$.op') AS op,event_time AS at FROM library_events WHERE revision>? ORDER BY revision LIMIT 257").all(since),reset=!url.searchParams.has('since')||since<revision-256||delta.length>256;
          sendJson(res,{...store.snapshotPage(),...state,reset,changes:reset?[]:delta});
        }
      }
    }
    else if(req.method==='GET'&&url.pathname==='/api/library/sync')sendJson(res,sync.view());
    else if(req.method==='POST'&&url.pathname==='/api/library/sync')sendJson(res,await sync.configure(await readJson(req),req.revalidateAccess));
    else if(req.method==='POST'&&url.pathname==='/api/library/operations'){const input=await readJson(req);req.checkLibraryOperation?.(input);sendJson(res,{event:store.write(input)});}
    else if(req.method==='POST'&&url.pathname==='/api/library/import'){
      sendJson(res,store.importOperations(await readJson(req)));
    }else throw new LibraryError(404,'unknown library route');
  }catch(error){const full=error.errcode===13 || error.code==='SQLITE_FULL';const known=error instanceof LibraryError || error instanceof AccountError;sendJson(res,{error:full?'个人资料存储额度不足，请稍后重试':known?error.message:'本地资料保存失败'},full?507:known?error.status:500);}
  return true;
};}
