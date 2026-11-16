'use strict';

const { money } = require('./farm-batch');

const number = value => value.toLocaleString('en-GB');

function collected(entry) {
  return entry.state.groups.filter(group => entry.state.completed.has(group._id)).length;
}

function bar(done, total, format = number) {
  return total ? { bar: done / total, text: format(done) + ' / ' + format(total) } : '—';
}

function createRunProgress() {
  let plan;
  let accounts;
  return {
    begin(next, job) {
      if (plan !== next) {
        plan = next;
        accounts = new Map(plan.jobs.map(({ id, route, result, entries }) => [id, {
          id, route, name: result[0], rules: plan.rules, opened: 0, submitted: 0, claimed: 0, cashCents: 0, credits: 0,
          phase: 'Queued', current: null, entries: entries.map(entry => ({ ...entry, protectedGroups: new Set(entry.protectedGroups) })),
        }]));
      }
      const run = accounts.get(job.id);
      run.phase = 'Starting';
      return run;
    },
    end() {
      for (const run of accounts?.values() || []) {
        if (run.phase === 'Queued') run.phase = 'Stopped before starting';
      }
    },
    blocks() {
      if (!accounts) return [];
      const runs = [...accounts.values()];
      const active = runs.find(run => run.current);
      const showCash = plan.rules.cashBudget > 0;
      const showArmory = plan.rules.credits > 0;
      const columns = ['Account', 'Collection skins', ...(showCash ? ['Cash used'] : []),
        ...(showArmory ? ['Armory credits used'] : []), 'Activity'];
      return [{
        type: 'section', title: 'Run progress', blocks: [
          ...(active ? [{
            type: 'table', columns: ['Account', 'Current collection', 'Skins collected', 'Step'],
            rows: [[active.name, active.current.name, bar(collected(active.current), active.current.ids.size), active.phase]],
          }] : []),
          {
            type: 'table', columns, rows: runs.map(run => {
              const total = run.entries.reduce((sum, entry) => sum + entry.ids.size, 0);
              const done = run.entries.reduce((sum, entry) => sum + collected(entry), 0);
              const counts = [number(run.opened) + ' opened', number(run.submitted) + ' submitted', number(run.claimed) + ' claimed'];
              return [
                run.name, bar(done, total),
                ...(showCash ? [bar(run.cashCents, plan.rules.cashBudget, cents => money(cents / 100))] : []),
                ...(showArmory ? [bar(run.credits, plan.rules.credits)] : []),
                [run.phase, ...counts].join(' · '),
              ];
            }),
          },
        ],
      }];
    },
  };
}

module.exports = { createRunProgress };
