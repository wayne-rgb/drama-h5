import { AccountError } from './account-store.mjs';

// 业务错误保留可操作提示，内部异常只在服务端记录，不能回传路径或数据库信息。
export function publicFailure(error) {
  if (error instanceof AccountError) return { status: error.status, message: error.message };
  return { status: 500, message: '操作失败，请稍后重试' };
}
