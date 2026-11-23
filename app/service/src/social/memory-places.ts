import { groupPlaceSql } from "./place.ts";

// Two helpers over `place.ts`'s frozen SQL, for the places memory and the lookups read (Agent social, lane A; A-4 review m11): the
// spelling of "which conversations an Agent's memory may look at" lives here and in `place.ts`, never inline.

/** SQL: `${c}` (a conversations alias) is an Agent's own conversation or a group: where an Agent's elsewhere lookups and its heard-from places are. A social conversation is neither. */
export const ownOrGroupPlaceSql = (c: string): string => `(${groupPlaceSql(c)} or ${c}.type = 'agent')`;
