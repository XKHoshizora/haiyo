/**
 * What the service's model catalogue reports of a model it knows, each sent only as `true`: `reportedTools` (its replies can
 * call tools) and what it takes and answers with. THE ONE LIST of those names in the web: the marks' table reads the fields
 * (ui/ModelMarks.jsx), and every list that carries a model along for it keeps exactly these — a provider's models and the
 * site's (data/model.js), a row of a provider's own list (data/actions.js), the provider form. A name added here reaches all
 * of them. None is ever sent back: the service refuses them.
 */
export const REPORTED = Object.freeze(["reportedTools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"]);

/** Those of `model` that are exactly true, and nothing else of it. */
export const reportedOf = (model) => Object.fromEntries(REPORTED.filter((key) => model?.[key] === true).map((key) => [key, true]));
