'use strict';

function status(account) {
  if (account.healthy) return 'Healthy';
  return account.running ? 'Needs attention' : 'Stopped';
}

module.exports = {
  start(ctx) {
    ctx.panel.action('summarise', () => {
      const accounts = ctx.accounts.list();
      const healthy = accounts.filter(account => account.healthy).length;
      return { message: `${healthy} of ${accounts.length} accounts are clicking normally.` };
    });

    ctx.panel.tab('Account Pulse', () => {
      const accounts = ctx.accounts.list();
      const running = accounts.filter(account => account.running);
      const healthy = running.filter(account => account.healthy);
      const visible = ctx.settings.get('runningOnly') ? running : accounts;

      return {
        blocks: [
          {
            type: 'stats',
            items: [
              { label: 'Accounts', value: accounts.length },
              { label: 'Healthy', value: healthy.length },
              { label: 'Needs attention', value: running.length - healthy.length },
              { label: 'Stopped', value: accounts.length - running.length },
            ],
          },
          { type: 'settings', keys: ['runningOnly'] },
          {
            type: 'table',
            columns: ['Account', 'Farmer status'],
            rows: visible.map(account => [account.name || 'Unnamed account', status(account)]),
            empty: 'No accounts match this view.',
          },
          { type: 'buttons', items: [{ label: 'Show summary', action: 'summarise' }] },
        ],
      };
    });
  },
};
