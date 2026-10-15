import fs from 'node:fs';
import path from 'node:path';
import { AccountError } from './account-store.mjs';

// 第一轮使用真实本地文件；业务层只持有素材标识和存储引用。
export class LocalMediaStorage {
  constructor(directory, config = process.env) {
    const root = path.resolve(config.CONTENT_MEDIA_DIR || path.join(directory, 'media'));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
    this.id = 'local';
  }

  filePath(key, suffix = '') {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(key) || !['', '.part', '.processing'].includes(suffix)) {
      throw new AccountError(400, '媒体文件标识无效');
    }
    const filename = path.join(this.root, `${key}${suffix}`);
    // 包括悬空链接在内的符号链接都不能作为上传或播放目标。
    try {
      if (fs.lstatSync(filename).isSymbolicLink()) throw new AccountError(503, '媒体文件位置无效');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return filename;
  }

  reference(asset, size = asset.size) {
    return { assetId: asset.id, storageId: this.id, objectKey: asset.id, version: asset.id, size };
  }

  locate(store, asset) {
    let location = store.assetLocation(asset.id);
    // 兼容历史文件及旧版本写入的素材，不改变文件名和分集标识。
    if (!location) {
      location = this.reference(asset);
      store.saveAssetLocation(location);
    }
    if (location.storageId !== this.id) throw new AccountError(503, '素材存储暂不可用');
    const filename = this.filePath(location.objectKey);
    let stat;
    try { stat = fs.statSync(filename); }
    catch (error) {
      // 保留旧媒体接口的通用失败响应，同时避免在错误文本中携带磁盘路径。
      if (error.code === 'ENOENT') throw new Error('媒体文件暂不可用');
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size !== location.size) throw new AccountError(503, '媒体文件不完整');
    return { location, stat, open: (range) => fs.createReadStream(filename, range) };
  }
}
