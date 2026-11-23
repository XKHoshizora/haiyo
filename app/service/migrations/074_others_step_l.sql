-- Up Migration
-- Step L (design §5; plan B4). Deploys only with lane B's code, which makes an Agent's number a sub-limit inside its owner's
-- (Controller ruling 2026-11-24 (verification), E1/N1).
-- Controller ruling 2026-11-24 (attack, I7), changed by Owner decision 2026-11-25 (cap): an Agent's number still at migration 020's
-- default (exactly 20 points) is REMOVED (null: no sub-limit of its own), not raised. A value an owner set to exactly 20 cannot be told from
-- the default, so every row at exactly 20 points is cleared; a number set to anything else is kept. New Agents get none of their own.
-- The owner's numbers are not written here: null reads OTHERS.answersPerDay (50) and OTHERS.pointsPerDay (300), one value per owner however
-- many Agents they have (plan "Owner decision 2026-11-25").
update agents set others_budget_micro = null where others_budget_micro = 20000000;
-- Controller ruling 2026-11-24 (B-2 dispatch): the others' number keeps a NULL column default after this migration (a new Agent has no
-- sub-limit of its own; the owner's per-day cap, 300 points and 50 answers, is what applies). 074 drops 020's default of 20, so a new row
-- reads null.
alter table agents alter column others_budget_micro drop default;
-- Controller ruling 2026-11-24 (B-1 review, B-2 dispatch): the proactive budget is a hard sub-cap that counts holds. Rows still at the old
-- default 20 become 70 (the same rule as the others' number: every row at exactly 20 points; a number an owner set below or above 20 stays),
-- and the column default becomes 70 for new Agents.
update agents set proactive_budget_micro = 70000000 where proactive_budget_micro = 20000000;
alter table agents alter column proactive_budget_micro set default 70000000;
-- Down Migration
-- (the clearing and the raise are not undone: a null cannot be told from an owner's own choice of no limit, and a row at 70 not from one an
-- owner set. Agents made after Up keep a null others' number, which code from before 074 reads as no limit, so Down leaves them.)
alter table agents alter column others_budget_micro set default 20000000;
alter table agents alter column proactive_budget_micro set default 20000000;
