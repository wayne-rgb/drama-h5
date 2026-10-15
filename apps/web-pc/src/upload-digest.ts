export function uploadDigest(file: Blob): Promise<string> {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./upload-digest.worker.ts',import.meta.url),{type:'module'});
    const fail=()=>{worker.terminate();reject(new Error('无法校验原文件，请重新选择'));};
    worker.onerror=fail;
    worker.onmessage=event=>{if(event.data.error){fail();return;}worker.terminate();resolve(event.data.digest);};
    worker.postMessage({file});
  });
}

// 旧队列只保存过首尾摘要，首次恢复时仍须保留原有文件核对。
export async function legacyUploadDigest(file: Blob): Promise<string> {
  const first=new Uint8Array(await file.slice(0,65536).arrayBuffer()),last=new Uint8Array(await file.slice(Math.max(0,file.size-65536)).arrayBuffer());
  const bytes=new Uint8Array(first.length+last.length);bytes.set(first);bytes.set(last,first.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
