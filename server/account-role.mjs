// 管理权限绑定不可自行指定的账户编号；邮箱方式必须先完成邮箱验证。
export function isAdministrator(account, config = process.env) {
  if (!account) return false;
  const values = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  return values(config.ADMIN_ACCOUNT_IDS).includes(account.id) || !!account.email_verified && values(config.ADMIN_EMAILS).map(email => email.toLowerCase()).includes(account.email);
}
