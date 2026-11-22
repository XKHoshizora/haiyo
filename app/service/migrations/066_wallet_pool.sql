-- Up Migration
-- One pooled hold per run, split into pots at settlement (wallet v3, lane websearch2; src/metering/pool.ts, wallet.ts).
-- `agent_runs.money_rule`: which rule wrote the run's money — 0 the old code's (one source per run, `charge_to`), 1 the
-- pool's; set to 1 by `admitRun` only, so a row old code admits during a deploy's overlap keeps 0 and is settled by the
-- legacy branch. In rule 1 `charge_to` names the model's tier class (`free`: allowance then balance; `balance`: the
-- balance only), no new value: 038's check is unchanged.
-- `hold_over_micro`: of the model's part of `hold_micro`, what was held beyond what the pots could cover then (a reply
-- that started alone past them, or a last round); `web_charge_micro`: what the run's searches are to be charged — the
-- price at each pre-hold, lowered after the engine to its actual (never above the price, so never above `web_micro`).
-- The model's part promised is `hold_micro − web_micro − hold_over_micro`. Every writer raises `hold_micro` and
-- `hold_over_micro` in one statement; the checks keep the three in their bounds while a hold stands (`hold_micro` is
-- zeroed at settlement, the rest kept as the record of what was held). Old code writes none of the new columns: their
-- defaults satisfy both checks for every row it writes (its searches raise `hold_micro` by their price first).
-- `usage_records.money_rule`: the rule the record was settled by.
alter table agent_runs
  add column money_rule smallint not null default 0 check (money_rule in (0, 1)),
  add column hold_over_micro bigint not null default 0,
  add column web_charge_micro bigint not null default 0;
alter table agent_runs add constraint agent_runs_hold_parts check (hold_over_micro >= 0 and (hold_micro = 0 or web_micro + hold_over_micro <= hold_micro));
alter table agent_runs add constraint agent_runs_web_charge check (web_charge_micro >= 0 and web_charge_micro <= web_micro);
alter table usage_records add column money_rule smallint not null default 0 check (money_rule in (0, 1));

-- Down Migration
-- Rule-1 rows are read by the old rule afterwards: conservative on the allowance, their searches charged at the price.
alter table usage_records drop column money_rule;
alter table agent_runs drop constraint agent_runs_web_charge;
alter table agent_runs drop constraint agent_runs_hold_parts;
alter table agent_runs drop column web_charge_micro, drop column hold_over_micro, drop column money_rule;
