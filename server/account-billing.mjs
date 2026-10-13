import Stripe from 'stripe';
import { AccountError, membershipPlans } from './account-store.mjs';

// 支付服务尚未选定时保持关闭；Stripe是可选适配器，不影响账号与套餐数据。
export function createBilling(store, config, origin) {
  const ready = config.BILLING_PROVIDER === 'stripe' && !!config.STRIPE_SECRET_KEY && !!config.STRIPE_WEBHOOK_SECRET;
  const stripe = ready ? new Stripe(config.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 }) : null;
  const customers = new Map();
  const checkouts = new Map();
  const ensureReady = () => { if (!stripe) throw new AccountError(503, '订阅支付尚未配置'); };
  const syncSubscription = async (subscriptionId, eventId, eventAt) => {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const account = store.byId(subscription.metadata.account_id || '');
    const item = subscription.items.data[0], plan = membershipPlans.find(row => row.id === subscription.metadata.plan_id);
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    if (!account || account.customer_id !== customerId || !plan || subscription.items.data.length !== 1 || item.quantity !== 1 || item.price.currency !== 'usd' || item.price.unit_amount !== plan.amount || item.price.recurring?.interval !== plan.interval || item.price.recurring?.interval_count !== 1) throw new AccountError(400, '订阅记录校验失败');
    const periodEnd = (item.current_period_end || subscription.current_period_end) * 1000;
    if (!Number.isFinite(periodEnd)) throw new AccountError(400, '订阅记录校验失败');
    store.saveSubscription(eventId, { id: subscription.id, accountId: account.id, planId: plan.id, status: subscription.status, periodEnd, cancelAtPeriodEnd: subscription.cancel_at_period_end }, eventAt);
  };
  return {
    ready, provider: ready ? 'stripe' : null,
    async checkout(account, planId) {
      ensureReady();
      if (!account.email_verified) throw new AccountError(403, '请先验证邮箱');
      if (store.membership(account.id).active) throw new AccountError(409, '已开通会员，请前往管理订阅');
      const plan = membershipPlans.find(row => row.id === planId);
      if (!plan) throw new AccountError(400, '请选择有效的会员套餐');
      const pending = (checkouts.get(account.id) || Promise.resolve()).catch(() => {}).then(async () => {
      account = store.byId(account.id);
      if (!account.customer_id) {
        if (!customers.has(account.id)) customers.set(account.id, stripe.customers.create({ email: account.email, name: account.name, metadata: { account_id: account.id } }, { idempotencyKey: `account:${account.id}` }).then(customer => { store.customer(account.id, customer.id); return customer.id; }).finally(() => customers.delete(account.id)));
        account.customer_id = await customers.get(account.id);
      }
      const existing = await stripe.subscriptions.list({ customer: account.customer_id, status: 'all', limit: 100 });
      if (existing.has_more || existing.data.some(row => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(row.status))) throw new AccountError(409, '已有订阅，请前往管理订阅');
      const openSessions = await stripe.checkout.sessions.list({ customer: account.customer_id, status: 'open', limit: 100 });
      for (const previous of openSessions.data.filter(row => row.client_reference_id === account.id && row.mode === 'subscription')) {
        if (previous.metadata?.plan_id === plan.id && previous.url) return { url: previous.url };
        await stripe.checkout.sessions.expire(previous.id);
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer: account.customer_id, client_reference_id: account.id,
        metadata: { account_id: account.id, plan_id: plan.id },
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: plan.amount, recurring: { interval: plan.interval }, product_data: { name: plan.id === 'monthly' ? 'VIP · Monthly' : 'VIP · Annual' } } }],
        subscription_data: { metadata: { account_id: account.id, plan_id: plan.id } },
        success_url: `${origin}/?account=membership&checkout={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}/?account=membership`,
      });
      return { url: session.url };
      });
      checkouts.set(account.id, pending);
      try { return await pending; } finally { if (checkouts.get(account.id) === pending) checkouts.delete(account.id); }
    },
    async portal(account) {
      ensureReady();
      if (!account.customer_id) throw new AccountError(400, '当前账户没有订阅记录');
      return { url: (await stripe.billingPortal.sessions.create({ customer: account.customer_id, return_url: `${origin}/?account=membership` })).url };
    },
    async confirm(account, sessionId) {
      ensureReady();
      if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{10,256}$/.test(sessionId)) throw new AccountError(400, '订阅记录校验失败');
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.customer !== account.customer_id || session.client_reference_id !== account.id || session.mode !== 'subscription') throw new AccountError(403, '订阅记录校验失败');
      if (session.status !== 'complete' || session.payment_status !== 'paid' || !session.subscription) throw new AccountError(409, '付款状态尚未确认，请稍后刷新');
      await syncSubscription(typeof session.subscription === 'string' ? session.subscription : session.subscription.id, `confirm:${sessionId}:${Date.now()}`, 0);
    },
    async webhook(body, signature) {
      ensureReady();
      let event;
      try { event = stripe.webhooks.constructEvent(body, signature, config.STRIPE_WEBHOOK_SECRET); }
      catch { throw new AccountError(400, '支付通知签名无效'); }
      const object = event.data.object;
      const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : event.type === 'checkout.session.completed' ? object.subscription : ['invoice.paid', 'invoice.payment_failed'].includes(event.type) ? object.parent?.subscription_details?.subscription || object.subscription : null;
      if (subscriptionId) await syncSubscription(typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id, event.id, event.created * 1000);
      return { received: true };
    },
  };
}
