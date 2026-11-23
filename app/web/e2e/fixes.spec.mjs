// The two layout fixes after batch 1, measured in a real browser (jsdom has no layout): a bubble is as wide as its
// content on both sides (the name-and-time line does not stretch other people's), and 已读 sits right under my
// bubble, aligned to its right edge, while the hover-only 回复 control takes no room next to it.
import { test, expect } from "./support/fixtures.mjs";
import { befriend, uniq } from "./support/accounts.mjs";
import { chatPane, composer, createGroupUi, expectStored, messagesWith, openChat, sendFile, sendText } from "./support/app.mjs";
import { png, randomFile } from "./support/files.mjs";
import { capture } from "./support/shots.mjs";

const box = async (locator) => {
  const b = await locator.boundingBox();
  expect(b, "the element is laid out").not.toBeNull();
  return b;
};

/** The part of a message that is its body: the bubble, an image, or a file card (the first one). */
const bodyOf = (item) => item.locator(".bubble, .attachment-image, .file-card").first();

/** Two friends with their chats open; the first's name is long, so its name-and-time line is wide. */
async function pair(people) {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo", { displayName: `名字很长的朋友${uniq(4)}甲乙丙丁戊己庚辛` });
  await befriend(ann, bo);
  const chats = { ann: await openChat(ann.page, bo.displayName), bo: await openChat(bo.page, ann.displayName) };
  return { ann, bo, chats };
}

test("the same one-emoji message has the same bubble width on both sides; another person's short bubble is not stretched by the name line", async ({ people }) => {
  const { ann, bo, chats } = await pair(people);
  const emoji = "👍";
  await sendText(ann.page, bo.displayName, emoji);
  await expect(messagesWith(chats.bo, emoji)).toHaveCount(1);
  // (the same text again, from the other person: sendText expects one match, so type it here)
  await composer(chats.bo).fill(emoji);
  await composer(chats.bo).press("Enter");
  await expect(messagesWith(chats.bo, emoji)).toHaveCount(2);
  await expect(messagesWith(chats.ann, emoji)).toHaveCount(2);

  // In Ann's window: her own bubble and Bo's.
  const mine = await box(chats.ann.locator("li.mine .bubble", { hasText: emoji }));
  const theirs = await box(chats.ann.locator("li.theirs .bubble", { hasText: emoji }));
  expect(Math.abs(mine.width - theirs.width), `bubbles ${mine.width}px and ${theirs.width}px`).toBeLessThanOrEqual(1);
  // And in Bo's window (the roles swap): the same width again.
  const boMine = await box(chats.bo.locator("li.mine .bubble", { hasText: emoji }));
  const boTheirs = await box(chats.bo.locator("li.theirs .bubble", { hasText: emoji }));
  expect(Math.abs(boMine.width - boTheirs.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(mine.width - boMine.width)).toBeLessThanOrEqual(1);

  // A short text from the person with the long name: narrower than that message's name-and-time line.
  const short = "好";
  await sendText(bo.page, ann.displayName, short);
  const item = messagesWith(chats.ann, short);
  await expect(item).toHaveCount(1);
  const row = await box(item.locator(".msg-meta"));
  const bubble = await box(item.locator(".bubble"));
  expect(row.width, "the name-and-time line is the wider one here").toBeGreaterThan(bubble.width + 40);
  // ...and left-aligned with it (the line and the bubble start at the same x).
  expect(Math.abs(row.x - bubble.x)).toBeLessThanOrEqual(1);
  await capture(ann.page, "fix-same-emoji-bubbles");
});

for (const [label, size] of [
  ["desktop", { width: 1280, height: 860 }],
  ["mobile", { width: 390, height: 800 }],
]) {
  test(`已读 is right under my bubble, right-aligned to it; hovering shows 回复 without moving it (${label})`, async ({ people }) => {
    const { ann, bo, chats } = await pair(people);
    await ann.page.setViewportSize(size);
    const tag = uniq(4);
    const line = `我说一句话 ${tag}`;
    await sendText(ann.page, bo.displayName, line);
    const item = messagesWith(chats.ann, line);
    const receipt = item.locator(".msg-foot .receipt");
    await expect(receipt).toHaveText("已读"); // Bo has the chat open: it is read at once
    await item.scrollIntoViewIfNeeded();

    const bubble = await box(item.locator(".bubble"));
    const before = await box(receipt);
    expect(Math.abs(before.x + before.width - (bubble.x + bubble.width)), "已读 right edge vs bubble right edge").toBeLessThanOrEqual(2);
    expect(before.y, "已读 is below the bubble").toBeGreaterThanOrEqual(bubble.y + bubble.height - 0.5);

    // The 回复 control: hidden until hover (on a mouse device), then shown to the left of 已读; 已读 does not move.
    const reply = item.getByRole("button", { name: "回复" });
    const touch = await ann.page.evaluate(() => matchMedia("(hover: none)").matches);
    if (!touch) await expect(reply).toHaveCSS("opacity", "0");
    await item.hover();
    await expect(reply).toHaveCSS("opacity", "1");
    await expect(reply).toBeVisible();
    const after = await box(receipt);
    expect(after).toEqual(before);
    const replyBox = await box(reply);
    expect(replyBox.x + replyBox.width, "回复 is left of 已读").toBeLessThanOrEqual(after.x + 0.5);
    const pane = await box(chats.ann.getByTestId("message-list"));
    const inside = (b) => b.x >= pane.x - 0.5 && b.x + b.width <= pane.x + pane.width + 0.5;
    expect(inside(replyBox), `my 回复 ${JSON.stringify(replyBox)} inside the message pane ${JSON.stringify(pane)}`).toBe(true);
    if (label === "desktop") await capture(ann.page, "fix-read-receipt");

    // The other person's message: its 回复 shows inside the pane too.
    const theirs = `对方说一句 ${tag}`;
    await sendText(bo.page, ann.displayName, theirs);
    const their = messagesWith(chats.ann, theirs);
    await expect(their).toHaveCount(1);
    await their.scrollIntoViewIfNeeded();
    await their.hover();
    const theirReply = their.getByRole("button", { name: "回复" });
    await expect(theirReply).toHaveCSS("opacity", "1");
    const theirBox = await box(theirReply);
    expect(inside(theirBox), `their 回复 ${JSON.stringify(theirBox)} inside the message pane ${JSON.stringify(pane)}`).toBe(true);
  });
}

test("已读 is aligned to the body for an image and a file, and a group message's foot stays under the bubble", async ({ people }) => {
  const { ann, bo, chats } = await pair(people);
  await ann.page.setViewportSize({ width: 1280, height: 860 });
  const tag = uniq(4);
  const image = { name: `图-${tag}.png`, mimeType: "image/png", buffer: png(48, 32) };
  await sendFile(ann.page, bo.displayName, image, "选择图片或视频");
  const file = { name: `文件-${tag}.bin`, mimeType: "application/octet-stream", buffer: randomFile(2048) };
  await sendFile(ann.page, bo.displayName, file);
  for (const name of [image.name, file.name]) {
    const item = messagesWith(chats.ann, name);
    const receipt = item.locator(".msg-foot .receipt");
    await expect(receipt).toHaveText("已读");
    const body = await box(bodyOf(item));
    const r = await box(receipt);
    expect(Math.abs(r.x + r.width - (body.x + body.width)), `${name}: 已读 right edge vs body right edge`).toBeLessThanOrEqual(2);
    expect(r.y).toBeGreaterThanOrEqual(body.y + body.height - 0.5);
  }
  // Bo's side shows the same two bodies, the same widths as on Ann's.
  for (const name of [image.name, file.name]) {
    await expectStored(chats.bo, name);
    const a = await box(bodyOf(messagesWith(chats.ann, name)));
    const b = await box(bodyOf(messagesWith(chats.bo, name)));
    expect(Math.abs(a.width - b.width), name).toBeLessThanOrEqual(1);
  }
});

test("in a group, my bubble and the foot under it line up the same way", async ({ people }) => {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo");
  const cy = await people.member("Cy");
  await befriend(ann, bo);
  await befriend(ann, cy);
  const title = `对齐群${uniq(4)}`;
  await createGroupUi(ann.page, title, [bo.displayName, cy.displayName]);
  const chat = chatPane(ann.page, title);
  await sendText(ann.page, title, "群里说话");
  const item = messagesWith(chat, "群里说话");
  await item.hover();
  const reply = item.getByRole("button", { name: "回复" });
  await expect(reply).toHaveCSS("opacity", "1");
  const bubble = await box(item.locator(".bubble"));
  const r = await box(reply);
  // No receipt in a group: the control sits under the bubble, its right edge at the bubble's right edge.
  expect(r.y).toBeGreaterThanOrEqual(bubble.y + bubble.height - 0.5);
  expect(r.x + r.width).toBeLessThanOrEqual(bubble.x + bubble.width + 11);
});
