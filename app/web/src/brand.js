/** The product's public name: every text a person sees takes it from here (index.html's <title> spells it too; tests/brand.test.js keeps them equal). */
export const PRODUCT_NAME = "Haiyo";

/** A page's title in the tab and in the history: the page first, then the product (unless the page's own name already says it). */
export const titled = (name) => (String(name).includes(PRODUCT_NAME) ? String(name) : `${name} · ${PRODUCT_NAME}`);
