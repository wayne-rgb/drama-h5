// 预览入口独立于观众页面，不能借用同一浏览器中的个人资料。
export const teamPreview = window.location.pathname.replace(/\/+$/, '') === '/preview';
export const previewHeaders = teamPreview ? { 'X-Team-Preview': '1' } : {};
