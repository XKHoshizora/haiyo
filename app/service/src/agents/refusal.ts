import { refusedSql } from "../social/reach.ts";

/**
 * SQL: person `subject` (a SQL expression: a column, a parameter with its cast) is refused by the Agent `agent` (SQL) in a group
 * (`refusedSql`: THE access decision: a block, a bar, an ended row, a deleted or disabled Agent). The switch is not asked of a group:
 * `socialOn` is a literal, never a bind parameter (a parameter nothing else uses makes Postgres reject the statement). Every group
 * site asks it (runs.ts, conversation.ts, proactive/candidates.ts), and so does lane A's `endGroupCalls` in the same terms.
 */
export const refusedInGroup = (subject: string, agent: string): string => refusedSql({ subject, agent, where: "group", socialOn: "false" });
