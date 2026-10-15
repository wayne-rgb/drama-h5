import { sha256 } from '@noble/hashes/sha2.js';

// 分块计算完整摘要，避免大视频一次载入内存或阻塞操作界面。
self.onmessage = async (event: MessageEvent<{ file: Blob }>) => {
  const hash=sha256.create();
  try {
    const reader=event.data.file.stream().getReader();
    try { for (;;) { const {done,value}=await reader.read();if(done)break;hash.update(value); } }
    finally {reader.releaseLock();}
    self.postMessage({digest:Array.from(hash.digest()).map(byte=>byte.toString(16).padStart(2,'0')).join('')});
  } catch {hash.destroy();self.postMessage({error:true});}
};
