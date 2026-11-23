// Task M in a real browser (Chromium): a mention picked from the @ list is a tag meaning the one picked. The composer
// keeps a textarea and draws each tag in a layer behind its text (Composer.jsx); these tests prove in a real layout
// engine that every tag's box lies on the very characters it covers — single line, wrapped, split across a wrap, after
// mixed CJK / Latin / emoji, scrolled inside a tall box, at phone width and at device scale factors 1.25 and 1.5 — that a
// tag deletes and edits as a unit, that the browser's own undo and redo and a real IME composition (Chrome's, through
// the DevTools protocol) keep the tags right, and that what is sent is stored, called and shown as picked. Screenshots
// (E2E_SHOTS=1) go to docs/acceptance/batch2-tools/shots/ as mentions-*.png.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, signInApi, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, chatPane, composer, messageList, openChat, rail } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { captureIn, polishShot } from "./support/shots.mjs";

const shot = captureIn("batch2-tools");

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service and its model stub");
  await modelStub.reset();
});

// --- setup through the API ------------------------------------------------------------------------------------------

const FREE = { source: "site", id: "e2e-free" };

/**
 * Ann (who owns the Agent), Bo and Cy, a group of the three and Ann's Agent. Bo's and Cy's display names and the
 * Agent's name are fixed when `boName`, `cyName`, `agentName` are given (random otherwise).
 */
async function world(people, { boName, cyName, agentName = `答答${uniq(4)}`, namePart = `ag_${uniq(8)}` } = {}) {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo", boName ? { displayName: boName } : {});
  const cy = await people.member("Cy", cyName ? { displayName: cyName } : {});
  await befriend(ann, bo);
  await befriend(ann, cy);
  const res = await ann.request.post("/api/agents", { data: { namePart, name: agentName, model: FREE, persona: "简短地回答。" } });
  expect(res.status(), await res.text()).toBe(201);
  const agent = await res.json();
  const title = `提到${uniq(6)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  const added = await ann.request.post(`/api/conversations/${groupId}/members`, { data: { principalId: agent.id } });
  expect(added.status(), await added.text()).toBe(201);
  return { ann, bo, cy, agent, groupId, title };
}

/** The open group's composer box of `page`. */
const boxOf = (page, title) => composer(chatPane(page, title));

/**
 * Types `@` at the caret — after a space when the character before it is none, as the composer's @ button does (the list
 * opens for an `@` at the start or after white space) — and picks the member whose name is `name` from the list.
 */
async function pick(page, name) {
  const before = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.value?.slice(0, el.selectionStart).slice(-1) ?? "";
  });
  await page.keyboard.type(before === "" || /\s/.test(before) ? "@" : " @");
  const option = page.getByRole("listbox", { name: "选择要提及的成员" }).getByRole("option").filter({ hasText: name });
  await expect(option.first()).toBeVisible();
  await option.first().click();
}

/** The tags the composer draws (its layer behind the text), as their text. */
const chips = (page) => page.locator(".composer-mirror .mention-chip").allTextContents();

/**
 * For every tag the composer draws: its boxes (one per line it is on) and the boxes of the same characters as the
 * textarea lays them out — measured with a Range in a clone made from the textarea's own computed style (not the
 * layer's), placed where the textarea is and scrolled as it is. Also the tag's text and where it is in the box's value.
 *
 * And against the textarea itself, where a page can see its layout (tidy round, m-3): a second textarea of the same
 * style and width, no height, gives by its scrollHeight how many lines a text takes in a textarea's own layout — of the
 * whole value (`lines.textarea`), against a div of the same style (`lines.div`: the clone's layout, which the tags are
 * checked against); and, for a tag followed by white space or nothing (where a line may break), of the value up to the
 * tag's end: the line the tag ends on in the textarea (`textareaEndLine`), against the line its last drawn box is on
 * (`drawnEndLine`).
 */
function measureTags() {
  const box = document.querySelector(".composer textarea");
  const mirror = document.querySelector(".composer-mirror");
  const cs = getComputedStyle(box);
  const STYLE = [
    "boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "fontFamily",
    "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontKerning", "fontFeatureSettings", "lineHeight", "letterSpacing",
    "wordSpacing", "textIndent", "textTransform", "tabSize", "whiteSpace", "overflowWrap", "wordBreak", "lineBreak", "direction", "textAlign",
    "scrollbarWidth", "scrollbarGutter", "overflowX", "overflowY",
  ];
  const clone = document.createElement("div");
  for (const p of STYLE) clone.style[p] = cs[p];
  const at = box.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight);
  const pads = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // The probes: no height (their scrollHeight is their text's), with a scroll bar exactly when the box has one.
  const bar = box.offsetWidth - box.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) > 0.5;
  const probe = (tag) => {
    const el = document.createElement(tag);
    for (const p of STYLE) el.style[p] = cs[p];
    Object.assign(el.style, { position: "fixed", left: "0px", top: "0px", height: "0px", minHeight: "0px", maxHeight: "none", overflowY: bar ? "scroll" : "hidden", visibility: "hidden", zIndex: "-1" });
    document.body.append(el);
    return el;
  };
  const area = probe("textarea");
  const flat = probe("div");
  const linesOf = (el) => Math.round((el.scrollHeight - pads) / lineHeight);
  // (The textarea keeps a line for its caret after a final line break; so does the layer, with a zero-width character
  // put after a final line break only, as the layer puts it.)
  const tail = box.value.endsWith("\n") ? "\u200b" : "";
  area.value = box.value;
  flat.textContent = `${box.value}${tail}`;
  const lines = { textarea: linesOf(area), div: linesOf(flat) };
  const contentTop = at.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - box.scrollTop;
  Object.assign(clone.style, { position: "fixed", left: `${at.left}px`, top: `${at.top}px`, margin: "0", visibility: "hidden", zIndex: "-1" });
  clone.textContent = `${box.value}${tail}`;
  document.body.append(clone);
  clone.scrollTop = box.scrollTop;
  const textNode = clone.firstChild;
  // One box per line: a Range may give a line several boxes (a run of another font, the space a line ends with), an
  // element one per line; the boxes of a line (overlapping in height) are put together.
  const rects = (list) => {
    const lines = [];
    for (const r of [...list].filter((b) => b.width > 0.5)) {
      const line = lines.find((l) => r.top < l.bottom - 1 && r.bottom > l.top + 1);
      if (!line) lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      else Object.assign(line, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right), top: Math.min(line.top, r.top), bottom: Math.max(line.bottom, r.bottom) });
    }
    return lines.sort((a, b) => a.top - b.top).map((l) => ({ x: l.left, y: l.top, w: l.right - l.left, h: l.bottom - l.top }));
  };
  const tags = [];
  let offset = 0;
  for (const node of mirror.childNodes) {
    const text = node.textContent;
    if (node.nodeType === 1 && node.classList.contains("mention-chip")) {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + text.length);
      const drawn = rects(node.getClientRects());
      const end = offset + text.length;
      let textareaEndLine = null;
      if (!/\S/.test(box.value[end] ?? "")) {
        area.value = box.value.slice(0, end);
        textareaEndLine = linesOf(area) - 1;
      }
      const last = drawn.at(-1);
      const drawnEndLine = last ? Math.floor((last.y + last.h / 2 - contentTop) / lineHeight) : null;
      tags.push({ text, start: offset, same: box.value.slice(offset, end) === text, drawn, laid: rects(range.getClientRects()), textareaEndLine, drawnEndLine });
    }
    offset += text.replace(/\u200b$/, "").length;
  }
  clone.remove();
  area.remove();
  flat.remove();
  return { tags, lines, scrollTop: box.scrollTop, mirrorScrollTop: mirror.scrollTop, boxTop: at.top, lineHeight, heights: { box: box.scrollHeight, layer: mirror.scrollHeight } };
}

/**
 * Every drawn tag lies on its own characters: the same text, the same number of line boxes, and each box within 1.5 px
 * of the characters' box (x, y, width, height); the textarea's own layout takes as many lines as the div's, and each tag
 * that can be checked so ends on the line of the textarea it is drawn on. First the layer has scrolled with the box (a
 * condition waited for, within one device pixel). Resolves with the measurement.
 */
async function expectTagsAligned(page, label) {
  await expect
    .poll(() => page.evaluate(() => Math.abs(document.querySelector(".composer textarea").scrollTop - document.querySelector(".composer-mirror").scrollTop) <= 1 / devicePixelRatio), {
      message: `${label}: the layer scrolled with the box`,
    })
    .toBe(true);
  const m = await page.evaluate(measureTags);
  expect(m.tags.length, `${label}: tags drawn`).toBeGreaterThan(0);
  expect(m.lines.textarea, `${label}: lines in the textarea's own layout and in the div's`).toBe(m.lines.div);
  expect(Math.abs(m.heights.box - m.heights.layer), `${label}: the layer itself is as tall as the box's text (box ${m.heights.box}, layer ${m.heights.layer})`).toBeLessThanOrEqual(1);
  for (const tag of m.tags) {
    if (tag.textareaEndLine !== null) expect(tag.drawnEndLine, `${label}: ${tag.text} ends on the textarea's line`).toBe(tag.textareaEndLine);
    expect(tag.same, `${label}: ${tag.text} is drawn over the same characters`).toBe(true);
    expect(tag.drawn.length, `${label}: ${tag.text} line boxes`).toBe(tag.laid.length);
    tag.drawn.forEach((d, i) => {
      const l = tag.laid[i];
      for (const k of ["x", "y", "w", "h"]) expect(Math.abs(d[k] - l[k]), `${label}: ${tag.text} box ${i} ${k} (drawn ${d[k]}, text ${l[k]})`).toBeLessThanOrEqual(1.5);
    });
  }
  return m;
}

/** Clears the box (select all, delete). */
async function clearBox(page, box) {
  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await expect(box).toHaveValue("");
}

/** The stored messages of the group, through `person`'s API, newest last. */
async function storedMessages(person, groupId) {
  const res = await person.request.get(`/api/conversations/${groupId}/messages`);
  expect(res.ok()).toBe(true);
  return (await res.json()).messages;
}

// --- 1. where the tags are drawn --------------------------------------------------------------------------------------

test("each tag is drawn exactly over its characters: one line, wrapped, split across a wrap, after CJK/Latin/emoji, scrolled, at phone width", async ({ people }) => {
  const { ann, bo, agent, title } = await world(people, { cyName: "Jarvis Lee" });
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);

  // One line: a person and the Agent.
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await page.keyboard.type("和 ");
  await pick(page, agent.name);
  expect(await chips(page)).toEqual([`@${bo.displayName}`, `@${agent.name}`]);
  await expect(box).toHaveValue(`你好 @${bo.displayName} 和 @${agent.name} `);
  await expectTagsAligned(page, "one line");
  await shot(page, "mentions-composer");

  // Wrapped: text long enough that both tags are on a later line.
  await clearBox(page, box);
  await page.keyboard.insertText("这一段文字很长，长到会在输入框里折行。".repeat(4));
  await pick(page, bo.displayName);
  await pick(page, agent.name);
  const wrapped = await expectTagsAligned(page, "wrapped");
  expect(wrapped.tags[0].drawn[0].y, "the tag sits below the first line").toBeGreaterThan(wrapped.boxTop + wrapped.lineHeight);

  // Mixed CJK, Latin and emoji right before the tag.
  await clearBox(page, box);
  await page.keyboard.insertText("混合 Mixed text 😀🎉👩‍💻 文字ABC");
  await pick(page, "Jarvis Lee");
  await expectTagsAligned(page, "after CJK, Latin and emoji");

  // Split across a wrap: text is put before the tag until the tag is on two lines.
  await clearBox(page, box);
  await pick(page, "Jarvis Lee");
  let split = false;
  for (let i = 0; i < 200 && !split; i += 1) {
    // The caret to the very start by the selection itself: Cmd+Home does not move it on macOS.
    await box.evaluate((el) => { el.focus(); el.setSelectionRange(0, 0); });
    await page.keyboard.insertText(i % 2 ? "字" : "a");
    split = (await page.evaluate(() => document.querySelector(".composer-mirror .mention-chip").getClientRects().length)) > 1;
  }
  expect(split, "a tag of two words came to sit across a wrap").toBe(true);
  const across = await expectTagsAligned(page, "split across a wrap");
  expect(across.tags[0].drawn).toHaveLength(2);

  // Scrolled inside a tall box: more lines than the box shows, a tag near the top and one at the end.
  await clearBox(page, box);
  await pick(page, bo.displayName);
  await page.keyboard.insertText(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
  await page.keyboard.insertText("\n");
  await pick(page, agent.name);
  const end = await expectTagsAligned(page, "scrolled to the end");
  expect(end.scrollTop, "the box scrolled").toBeGreaterThan(0);
  await box.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
  });
  await expectTagsAligned(page, "scrolled to the middle");
  await box.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expectTagsAligned(page, "scrolled to the top");

  // Phone width: the phone's type and padding for both.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(box).toBeVisible();
  await clearBox(page, box);
  await page.keyboard.type("手机上 ");
  await pick(page, bo.displayName);
  await page.keyboard.insertText("，然后很长很长很长很长很长很长的一段话，");
  await pick(page, "Jarvis Lee");
  await pick(page, agent.name);
  await expectTagsAligned(page, "phone width");
  await page.setViewportSize({ width: 1280, height: 860 });
});

// The phone-width step above with its names fixed, so the line it lays out is always the same one.
test("at phone width the fixed line 「手机上 @Bo68d9 ，然后很长…一段话， @Jarvis Lee @答答f3e4 」 takes the same lines in the box and in the layer", async ({ people }) => {
  const { ann, title } = await world(people, { boName: "Bo68d9", cyName: "Jarvis Lee", agentName: "答答f3e4" });
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(box).toBeVisible();
  await box.click();
  await page.keyboard.type("手机上 ");
  await pick(page, "Bo68d9");
  await page.keyboard.insertText("，然后很长很长很长很长很长很长的一段话，");
  await pick(page, "Jarvis Lee");
  await pick(page, "答答f3e4");
  await expect(box).toHaveValue("手机上 @Bo68d9 ，然后很长很长很长很长很长很长的一段话， @Jarvis Lee @答答f3e4 ");
  await expectTagsAligned(page, "fixed line at phone width");
  // A final line break: the textarea keeps a line for the caret, and so must the layer.
  await page.keyboard.press("Shift+Enter");
  await expect(box).toHaveValue(/\n$/);
  await expectTagsAligned(page, "fixed line and a final line break at phone width");
  await page.setViewportSize({ width: 1280, height: 860 });
});

for (const scale of [1.25, 1.5]) {
  test(`at device scale factor ${scale} each tag is still drawn over its characters`, async ({ people, browser }) => {
    const { ann, bo, agent, title } = await world(people, { cyName: "Jarvis Lee" });
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
    try {
      await signInApi(context.request, ann);
      const page = await context.newPage();
      await page.goto("/");
      await expect(rail(page)).toBeVisible();
      await openChat(page, title);
      const box = boxOf(page, title);
      await box.click();
      await page.keyboard.insertText("缩放 Zoom 😀 ");
      await pick(page, bo.displayName);
      await page.keyboard.insertText("这一段文字很长，长到会在输入框里折行。".repeat(3));
      await pick(page, "Jarvis Lee");
      await pick(page, agent.name);
      await expectTagsAligned(page, `scale ${scale}`);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectTagsAligned(page, `scale ${scale}, phone width`);
    } finally {
      await context.close();
    }
  });
}

// --- 2. a tag is one piece ------------------------------------------------------------------------------------------

test("Backspace at a tag's right edge takes the whole tag; a click inside a tag leaves the caret at an edge; typing with the caret put inside takes the tag whole", async ({ people }) => {
  const { ann, bo, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;

  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await expect(box).toHaveValue(`你好 ${tag} `);
  await page.keyboard.press("Backspace"); // the space after it
  await expect(box).toHaveValue(`你好 ${tag}`);
  await page.keyboard.press("Backspace"); // the tag, whole
  await expect(box).toHaveValue("你好 ");
  expect(await chips(page)).toEqual([]);

  // A click into the middle of the tag: the caret goes to one of its edges.
  await pick(page, bo.displayName);
  await page.keyboard.type("吗");
  const chip = page.locator(".composer-mirror .mention-chip");
  const r = await chip.evaluate((el) => el.getBoundingClientRect().toJSON());
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  const caret = await box.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  expect([3, 3 + tag.length], `the caret (${caret}) is at an edge of the tag`).toContain(caret[0]);
  expect(caret[1]).toBe(caret[0]);

  // The caret put inside the tag by a script (no click, no key): typing there takes the tag whole, keeps what was typed.
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await page.keyboard.type("x");
  await expect(box).toHaveValue("你好 x 吗");
  expect(await chips(page)).toEqual([]);
});

// --- 3. undo and redo (the browser's own editing: execCommand) --------------------------------------------------------

test("undo takes a picked tag back out, redo puts it back as the tag it was; undo after deleting a tag brings it back", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await expect(box).toHaveValue(`你好 ${tag} `);
  expect(await chips(page)).toEqual([tag]);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(box).toHaveValue("你好 @");
  expect(await chips(page)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(box).toHaveValue(`你好 ${tag} `);
  expect(await chips(page)).toEqual([tag]);
  await expectTagsAligned(page, "after redo");

  // Deleted with Backspace, then undone: the tag is back, with its id (the send carries it).
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(box).toHaveValue("你好 ");
  await page.keyboard.press("ControlOrMeta+Z");
  // (Chrome may undo the two deletions as one step: the space comes back too.)
  await expect(box).toHaveValue(new RegExp(`^你好 ${tag} ?$`));
  expect(await chips(page)).toEqual([tag]);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  expect((await storedMessages(ann, groupId)).at(-1).mentions).toEqual([{ id: bo.id, start: 3, length: tag.length }]);
});

// --- 4. a real IME composition next to a tag ------------------------------------------------------------------------

test("an IME composition (Chrome's, through the DevTools protocol) right before and right after a tag keeps its range and duplicates nothing", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  const ime = await page.context().newCDPSession(page);
  /** Composes `steps` (each the composition's text so far), then commits `done`. */
  const compose = async (steps, done) => {
    for (const text of steps) await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await ime.send("Input.insertText", { text: done });
  };

  await box.click();
  await pick(page, bo.displayName);
  await page.keyboard.press("Backspace"); // no space after it: the caret right at its end
  await expect(box).toHaveValue(tag);
  // Right after it.
  await compose(["n", "ni", "nih", "niha", "nihao"], "你好");
  await expect(box).toHaveValue(`${tag}你好`);
  expect(await chips(page)).toEqual([tag]);
  // Right before it.
  await box.evaluate((el) => el.setSelectionRange(0, 0));
  await compose(["w", "wo"], "我");
  await expect(box).toHaveValue(`我${tag}你好`);
  expect(await chips(page)).toEqual([tag]);
  await expectTagsAligned(page, "after composing");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  expect(last.text).toBe(`我${tag}你好`);
  expect(last.mentions).toEqual([{ id: bo.id, start: 1, length: tag.length }]);
});

test("an IME composition inside a tag keeps what was composed and takes the tag; a tap on 发送 with the composition open sends no piece of the tag (fix round 2, M-3)", async ({ people }) => {
  const { ann, bo, groupId, title } = await world(people);
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  const tag = `@${bo.displayName}`;
  const ime = await page.context().newCDPSession(page);
  const composing = async (steps) => {
    for (const text of steps) await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  };

  // Composed and committed inside the tag (the caret put there by a script: a click or a key would not leave it there).
  await box.click();
  await page.keyboard.type("你好 ");
  await pick(page, bo.displayName);
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await composing(["h", "ha"]);
  await ime.send("Input.insertText", { text: "哈" });
  await expect(box).toHaveValue("你好 哈 ");
  expect(await chips(page)).toEqual([]);
  expect(await box.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([4, 4]);

  // Composing inside a tag, then 发送 tapped before the composition is committed.
  await clearBox(page, box);
  await page.keyboard.type("再见 ");
  await pick(page, bo.displayName);
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await composing(["z", "zai"]);
  await chatPane(page, title).getByRole("button", { name: "发送", exact: true }).click();
  await expect(box).toHaveValue("");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "再见" })).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  // What was composed is sent as it stood (Chrome commits it when the box loses focus); no piece of the tag is.
  expect(last.text).toBe("再见 zai");
  expect(last.mentions ?? null).toBeNull();

  // 发送 clicked without the box losing focus (as a tap that keeps the keyboard up does), the composition still open:
  // the send itself cuts what is left of the tag (Composer.jsx send, tidy round m-4), and sends what was composed.
  await box.click();
  await page.keyboard.type("再来 ");
  await pick(page, bo.displayName);
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await composing(["l", "lai"]);
  await chatPane(page, title).getByRole("button", { name: "发送", exact: true }).dispatchEvent("click");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "再来" })).toHaveCount(1);
  const again = (await storedMessages(ann, groupId)).at(-1);
  expect(again.text).toBe("再来 lai");
  expect(again.mentions ?? null).toBeNull();
  // The composition the browser still holds is given up: the box stays empty.
  await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await expect(box).toHaveValue("");
});

// --- 5. what is sent ------------------------------------------------------------------------------------------------

test("sent: stored with its mentions; the picked Agent replies, the picked person starts nothing; both browsers show the tags", async ({ people }) => {
  const { ann, bo, agent, groupId, title } = await world(people);
  const page = ann.page;
  const annChat = await openChat(page, title);
  const boChat = await openChat(bo.page, title);
  await modelStub.reply("收到，我来看看。");
  const box = boxOf(page, title);
  await box.click();
  await pick(page, bo.displayName);
  await pick(page, agent.name);
  await page.keyboard.type("帮忙看看");
  await page.keyboard.press("Enter");
  await expect(messageList(annChat).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "帮忙看看" })).toHaveCount(1);

  const stored = (await storedMessages(ann, groupId)).find((m) => m.text.endsWith("帮忙看看"));
  expect(stored.mentions).toEqual([
    { id: bo.id, start: 0, length: bo.displayName.length + 1 },
    { id: agent.id, start: bo.displayName.length + 2, length: agent.name.length + 1 },
  ]);
  await modelStub.waitForCalls(1);
  await expect(agentMessagesWith(annChat, "收到，我来看看。")).toHaveCount(1);
  await page.waitForTimeout(1500);
  expect(await modelStub.calls(), "one model call: the Agent's; the person called nothing").toHaveLength(1);

  for (const [who, chat] of [
    ["sender", annChat],
    ["member", boChat],
  ]) {
    const mine = messageList(chat).locator(`li.msg[data-msg="m${stored.seq}"]`);
    const tags = mine.locator(".mention");
    await expect(tags, `${who} sees two tags`).toHaveCount(2);
    await expect(tags.nth(0).locator('[aria-hidden="true"]')).toHaveText(`@${bo.displayName}`);
    await expect(tags.nth(1)).toHaveClass(/mention-agent/);
    await expect(tags.nth(1).locator('[aria-hidden="true"]')).toHaveText(`@${agent.name}`);
  }
  await shot(bo.page, "mentions-message", { show: messageList(boChat).locator(`li.msg[data-msg="m${stored.seq}"]`) });
});

// --- 5b. the card of a mention --------------------------------------------------------------------------------------

test("a mention is a tinted name; hovering it opens a card with the kind, the account name and an Agent's owner; Esc closes it", async ({ people }) => {
  const { ann, bo, agent, title } = await world(people);
  const page = ann.page;
  const chat = await openChat(page, title);
  await modelStub.reply("收到。");
  const box = boxOf(page, title);
  await box.click();
  await pick(page, bo.displayName);
  await pick(page, agent.name);
  await page.keyboard.type("看一下");
  await page.keyboard.press("Enter");
  const message = messageList(chat).locator("li.msg.mine[data-msg^='m']").filter({ hasText: "看一下" });
  await expect(message).toHaveCount(1);
  const [person, bot] = [message.locator(".mention").nth(0), message.locator(".mention").nth(1)];

  // The tint, the radius, no frame (the stylesheet's own numbers, in a real engine).
  const look = await person.evaluate((el) => {
    const css = getComputedStyle(el);
    return { radius: css.borderTopLeftRadius, padding: css.padding, shadow: css.boxShadow, background: css.backgroundColor };
  });
  expect(look.radius).toBe("4px");
  expect(look.padding).toBe("1px 4px");
  expect(look.shadow).toBe("none");
  expect(look.background).not.toBe("rgba(0, 0, 0, 0)");

  await person.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toBeVisible();
  await expect(card).toContainText(bo.displayName);
  await expect(card).not.toContainText("真人");
  await expect(card).toContainText(`@${bo.handle}`);
  // It hangs over the page, outside the message: the message did not move.
  const before = await message.boundingBox();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  expect(await message.boundingBox()).toEqual(before);
  await page.mouse.move(0, 0);
  await person.hover();
  await expect(card).toBeVisible();
  await polishShot(page, "mention-own-bubble-card");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
  await polishShot(page, "mention-own-bubble");
  // The same message in another person's bubble (Bo's page).
  const boChat = await openChat(bo.page, title);
  const theirs = messageList(boChat).locator("li.msg.theirs").filter({ hasText: "看一下" });
  await expect(theirs).toHaveCount(1);
  await polishShot(bo.page, "mention-other-bubble");

  // By keyboard: Tab to the Agent's mention opens its card, with its owner.
  await bot.focus();
  await expect(card).toBeVisible();
  await expect(card).toContainText(agent.name);
  await expect(card).toContainText("Agent");
  await expect(card).toContainText(`主人：你`);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

// --- 6. a name of two words -----------------------------------------------------------------------------------------

test("a person named 「Jarvis Lee」 picked is one tag and calls no Agent, though an Agent of name part jarvis is in the group", async ({ people }) => {
  const { ann, cy, groupId, title } = await world(people, { cyName: "Jarvis Lee", namePart: "jarvis" });
  const page = ann.page;
  await openChat(page, title);
  const box = boxOf(page, title);
  await box.click();
  await pick(page, "Jarvis Lee");
  expect(await chips(page)).toEqual(["@Jarvis Lee"]);
  await page.keyboard.type("明天见");
  await page.keyboard.press("Enter");
  await expect(messageList(chatPane(page, title)).locator("li.msg.mine[data-msg^='m'] .mention")).toHaveCount(1);
  const last = (await storedMessages(ann, groupId)).at(-1);
  expect(last.mentions).toEqual([{ id: cy.id, start: 0, length: 11 }]);
  await page.waitForTimeout(2500);
  expect(await modelStub.calls(), "no Agent was called").toHaveLength(0);
});

// --- 7. an address in a reply ---------------------------------------------------------------------------------------

test("a URL with /@name in an Agent's reply is a link whose href is exactly the URL, with no tag in it", async ({ people }) => {
  const { ann, bo, agent, title } = await world(people);
  const page = ann.page;
  const chat = await openChat(page, title);
  const url = `https://example.com/@${bo.handle}`;
  const target = `https://x.example/u/@${bo.handle}`;
  await modelStub.reply(`主页 ${url} 和 [这里](${target}) @${bo.handle}`);
  const box = boxOf(page, title);
  await box.click();
  await pick(page, agent.name);
  await page.keyboard.type("给个链接");
  await page.keyboard.press("Enter");
  const reply = agentMessagesWith(chat, "主页");
  await expect(reply).toHaveCount(1);
  await expect(reply.locator(".md a").first()).toBeVisible();
  const hrefs = await reply.locator(".md a").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual([url, target]);
  await expect(reply.locator(".md a .mention")).toHaveCount(0);
  // The handle outside the addresses is the one mention.
  await expect(reply.locator(".mention")).toHaveCount(1);
});
