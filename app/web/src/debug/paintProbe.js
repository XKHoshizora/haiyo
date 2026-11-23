// DEBUG ONLY, to be removed once the blank band on the long forms (F2) is understood. `?paint=a|b|c|d` in the address applies ONE candidate
// mitigation to the long-form scrollers (styles/paint-probe.css) for the rest of the session and shows a small label with the variant;
// `?paint=off` ends it. Never linked from the UI; without the switch nothing happens.
const VARIANTS = ["a", "b", "c", "d"];
const KEY = "haiyo-paint-probe";

const remembered = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const remember = (value) => {
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    // (The variant then lasts for this load only.)
  }
};

export function applyPaintProbe() {
  const asked = new URLSearchParams(window.location.search).get("paint");
  let variant = remembered();
  if (asked === "off") {
    remember(null);
    return;
  }
  if (VARIANTS.includes(asked)) {
    remember(asked);
    variant = asked;
  }
  if (!VARIANTS.includes(variant)) return;
  document.documentElement.setAttribute("data-paint", variant);
  const label = document.createElement("div");
  label.setAttribute("data-paint-label", "");
  label.setAttribute("aria-hidden", "true");
  label.textContent = `paint ${variant}`;
  label.style.cssText = "position:fixed;left:6px;bottom:2px;z-index:2147483647;font:10px/1.2 monospace;color:#fff;background:rgba(0,0,0,.55);padding:1px 5px;border-radius:4px;pointer-events:none";
  document.body.append(label);
}
