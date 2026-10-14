// 管理权限绑定不可自行指定的账户编号；邮箱方式必须先完成邮箱验证。
export function isAdministratorAccount(account, config = process.env) {
  if (!account) return false;
  const values = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  return values(config.ADMIN_ACCOUNT_IDS).includes(account.id) || !!account.email_verified && values(config.ADMIN_EMAILS).map(email => email.toLowerCase()).includes(account.email);
}
export function isAdministrator(account, config = process.env) {
  return isAdministratorAccount(account,config) && (!account.mfa_enabled && config.ADMIN_REQUIRE_MFA!=='1' || account.session_mfa_at > Date.now()-12*3600000);
}
