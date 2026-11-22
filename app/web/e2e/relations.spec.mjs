// Unfriending and blocking take effect on the other side's open chat at once: its composer is disabled with the
// reason, without a reload. History stays; lifting the block opens the chat again.
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { chatPane, composer, expectOnce, expectStored, openChat, openContact, sendText } from "./support/app.mjs";

/** Nothing is offered (no box, no tools, no send) and the reason is said once, by the notice. */
async function expectHeld(chat, reason) {
  await expect(composer(chat)).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("status").filter({ hasText: reason })).toHaveCount(1); // (the notice, once: the composer says nothing more)
  await expect(chat.getByRole("status").filter({ hasText: reason })).toBeVisible();
}

test("unfriending disables the other side's composer with the reason, without a reload", async ({ people }) => {
  const [ann, bo] = await people.friendsOf(["Ann", "Bo"]);
  const annChat = await openChat(ann.page, bo.displayName);
  const boChat = await openChat(bo.page, ann.displayName);
  const line = `还是朋友的时候 ${uniq(4)}`;
  await sendText(bo.page, ann.displayName, line);
  await expectStored(annChat, line);

  await openContact(ann.page, bo.displayName);
  await ann.page.getByRole("button", { name: "解除好友" }).click();
  await ann.page.getByRole("dialog", { name: `解除与${bo.displayName}的好友关系` }).getByRole("button", { name: "确认解除" }).click();
  await expect(ann.page.getByRole("status").filter({ hasText: "已解除好友关系" })).toBeVisible();

  await expectHeld(boChat, "对方已不是你的好友，无法发送新的私聊。已有历史仍可查看。");
  await expect(boChat.getByText(`${ann.displayName}解除了与你的好友关系`)).toBeVisible();
  await expectOnce(boChat, line);
  await expectHeld(await openChat(ann.page, bo.displayName), "对方已不是你的好友");
});

test("blocking disables the other side's composer with the reason; unblocking enables it again", async ({ people }) => {
  const [ann, bo] = await people.friendsOf(["Ann", "Bo"]);
  const annChat = await openChat(ann.page, bo.displayName);
  const boChat = await openChat(bo.page, ann.displayName);
  const tag = uniq(4);
  await sendText(bo.page, ann.displayName, `拉黑之前 ${tag}`);

  await annChat.getByRole("button", { name: "会话资料" }).click();
  await ann.page.getByRole("button", { name: "拉黑此用户" }).click();
  await ann.page.getByRole("dialog", { name: `拉黑${bo.displayName}` }).getByRole("button", { name: "确认拉黑" }).click();

  await expectHeld(boChat, `${ann.displayName}拉黑了你，只能由对方解除`);
  await expectHeld(annChat, `你已拉黑 ${bo.displayName}`);
  await expectOnce(boChat, `拉黑之前 ${tag}`);

  await ann.page.getByRole("button", { name: "解除我的拉黑" }).click();
  await ann.page.getByRole("dialog", { name: `解除对${bo.displayName}的拉黑` }).getByRole("button", { name: "解除我的拉黑" }).click();
  await expect(composer(boChat)).toBeEnabled();
  await sendText(bo.page, ann.displayName, `解除之后 ${tag}`);
  await expectStored(chatPane(ann.page, bo.displayName), `解除之后 ${tag}`);
});
