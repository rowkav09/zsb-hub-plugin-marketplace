'use strict';

const LABEL = 'Collection Completer';

function createHandoff(ctx) {
  let held = null;

  async function withAccount(api, job, run, work) {
    const { id, route } = job;
    let requested = false;
    try {
      for (;;) {
        api.check(id, route);
        const busy = ctx.accounts.busy(id);
        // Existing requests go first. Once posted, our request has priority
        // over requests that arrive later, so two waiters cannot block each other.
        const earlier = requested ? null : ctx.accounts.wanted(id);
        if (!busy && !earlier) {
          ctx.accounts.setBusy(id, LABEL);
          held = id;
          if (requested) {
            ctx.accounts.want(id, null);
            requested = false;
          }
          return await work();
        }
        const reason = (busy || earlier).what || 'another plugin';
        run.phase = 'Waiting for account · ' + reason;
        if (!earlier && !requested) {
          ctx.accounts.want(id, LABEL);
          requested = true;
        }
        // Resolve even when Hub stops the plugin so the waiting action can unwind.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      const acquired = held === id;
      if (acquired) held = null;
      if (!ctx.stopping) {
        if (requested) ctx.accounts.want(id, null);
        if (acquired) ctx.accounts.setBusy(id, null);
      }
    }
  }

  const accounts = {
    ...ctx.accounts,
    // Previews can read a busy account. During writes, a foreign busy mark
    // still blocks the shared runner. Incoming requests wait for our release.
    busy: id => held === id ? ctx.accounts.busy(id) : null,
    wanted: () => null,
  };

  return { accounts, withAccount };
}

module.exports = { createHandoff };
