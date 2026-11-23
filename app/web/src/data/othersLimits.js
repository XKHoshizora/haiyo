// The ranges of the numbers an owner sets for what others cause (the service's: `PUT /api/me/others-limits`, an Agent's `othersLimit`),
// read in one place by the use page and the Agent form. The web only checks what is typed against them; the service decides.

/** The most answers a day either number may name (the service's range: 1 to 1000). */
export const ANSWERS_MAX = 1000;
/** What is said under an answers box holding anything else. */
export const ANSWERS_WRONG = `请填写 1 到 ${ANSWERS_MAX} 之间的整数`;

/** An answers number as typed: an integer 1-1000 (as a number), null for nothing typed, undefined for anything else. */
export function answersOf(text) {
  const typed = typeof text === "string" ? text.trim() : "";
  if (typed === "") return null;
  if (!/^\d{1,4}$/.test(typed)) return undefined;
  const value = Number(typed);
  return value >= 1 && value <= ANSWERS_MAX ? value : undefined;
}
