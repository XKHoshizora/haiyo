-- Up Migration
-- What of a usage record's balance charge was a paid reply's own debt: what it used beyond what the pool had promised it
-- (wallet v3, review M7; src/metering/settle.ts `settlePooled`). So the usage page can say why a balance went below zero —
-- a paid reply's overrun — rather than leave the owner to guess (an operator's adjustment down is the ledger's `adjust`;
-- a deploy's overlap leaves no mark of its own). 0 by the old rule and for every record before this.
alter table usage_records add column debt_micro bigint not null default 0;
alter table usage_records add constraint usage_records_debt check (debt_micro >= 0 and debt_micro <= balance_micro);

-- Down Migration
alter table usage_records drop constraint usage_records_debt;
alter table usage_records drop column debt_micro;
