// What a person does in the app, by the names they see on screen (roles, labels, texts).
import { expect } from "@playwright/test";

export const rail = (page) => page.getByRole("navigation", { name: "主导航" });

/**
 * One of the rail's sections: "消息", "通讯录", "Agent", "设置". An entry that carries a number is named with it (「消息，2 条未读」,
 * 「通讯录，1 条待处理」), so the name is matched as the section's, then nothing or that number.
 */
export async function goTo(page, section) {
  await rail(page).getByRole("button", { name: new RegExp(`^${section}(?:，|$)`) }).click();
}

/** A row of the conversation list (or of the contacts list) whose name is exactly `title`. */
export const listRow = (page, title) => page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) });

/** The open conversation titled `title`. */
export const chatPane = (page, title) => page.getByRole("region", { name: title, exact: true });

export const messageList = (chat) => chat.getByTestId("message-list");

/**
 * The messages of an open conversation whose text contains `text` — or whose picture is called `text` (a stored picture
 * shows the picture alone; its file name is the picture's accessible name, `alt`).
 */
export const messagesWith = (chat, text) => {
  const items = messageList(chat).getByRole("listitem");
  return items.filter({ hasText: withTags(text) }).or(items.filter({ has: chat.page().locator(`img[alt=${JSON.stringify(text)}]`) }));
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * `text` as it reads in a message whose mentions are drawn as tags. A typed `@name` or `@handle` that was stored as a
 * mention shows as a tag with the principal's current display name (`@Name`) and, for screen readers, the hidden words
 * 「提到 Name」 right after it; so each `@word` in `text` matches either itself (plain text) or such a tag. Any tag is
 * accepted there: the handle typed is not in the page. A text without `@` is matched as it is.
 */
export function withTags(text) {
  if (typeof text !== "string" || !text.includes("@")) return text;
  const parts = text.split(/(@[^\s，。,:：;；!?！？、]+)/);
  const tag = String.raw`@[^\s@]+?提到 [^\s@]+`;
  return new RegExp(parts.map((part, i) => (i % 2 === 1 ? `(?:${escapeRegExp(part)}|${tag})` : escapeRegExp(part))).join(""));
}

export const composer = (chat) => chat.getByRole("textbox", { name: "消息内容" });

/** Opens the conversation `title` from the list; resolves with its pane. */
export async function openChat(page, title) {
  await goTo(page, "消息");
  await listRow(page, title).first().click();
  const chat = chatPane(page, title);
  await expect(chat).toBeVisible();
  return chat;
}

/** Types and sends `text` in the open conversation `title`; resolves once the service stored it (it has a seq). */
export async function sendText(page, title, text) {
  const chat = chatPane(page, title);
  await composer(chat).fill(text);
  await composer(chat).press("Enter");
  await expectStored(chat, text);
}

/** Exactly one message containing `text`, stored at the service (`data-msg` is `m<seq>`, not a pending entry). */
export async function expectStored(chat, text) {
  const item = messagesWith(chat, text);
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-msg", /^m\d+$/);
}

/** Exactly one message containing `text` is shown in `chat`. */
export async function expectOnce(chat, text) {
  await expect(messagesWith(chat, text)).toHaveCount(1);
}

/** 消息 → 新建 → 发起群聊 with `title` and the friends named; resolves with the new group's pane (it opens). */
export async function createGroupUi(page, title, memberNames) {
  await goTo(page, "消息");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("button", { name: "发起群聊" }).click();
  const dialog = page.getByRole("dialog", { name: "发起群聊" });
  await dialog.getByLabel("群名称").fill(title);
  for (const name of memberNames) await dialog.getByRole("checkbox", { name }).check();
  await dialog.getByRole("button", { name: "创建群聊" }).click();
  await expect(dialog).toBeHidden();
  const chat = chatPane(page, title);
  await expect(chat).toBeVisible();
  return chat;
}

/**
 * Presses `opener` (a button that opens the file picker of an avatar: 更换头像, 选择头像), picks `file` ({name, mimeType,
 * buffer}) and resolves with the 调整头像 dialog that opens. Nothing is saved yet.
 */
export async function pickAvatarUi(page, opener, file) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: opener, exact: true }).click();
  await (await chooser).setFiles(file);
  const dialog = page.getByRole("dialog", { name: "调整头像" });
  await expect(dialog).toBeVisible();
  // The picture is decoded and painted: the controls are on.
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  return dialog;
}

/** 保存 in the 调整头像 dialog; resolves once it is closed (the service took the picture). */
export async function saveAvatarDialog(dialog) {
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Picks `file` in the open conversation's image or file picker; resolves once sent. */
export async function sendFile(page, title, file, picker = "选择文件") {
  const chat = chatPane(page, title);
  await chat.getByLabel(picker).setInputFiles(file);
  await expectStored(chat, file.name);
}

/** The open group's 群资料 page (members tab first). */
async function openGroupProfile(page, title) {
  await chatPane(page, title).getByRole("button", { name: "群资料" }).click();
  const profile = page.getByRole("region", { name: "群资料" });
  await expect(profile).toBeVisible();
  return profile;
}

async function backToChat(page, title, profile) {
  await profile.getByRole("button", { name: "返回群聊" }).click();
  await expect(chatPane(page, title)).toBeVisible();
}

/** 群资料 → 添加成员 → the friend named `name`. */
export async function addMemberUi(page, title, name) {
  const profile = await openGroupProfile(page, title);
  await profile.getByRole("button", { name: "添加成员" }).click();
  const dialog = page.getByRole("dialog", { name: "添加成员" });
  await dialog.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "添加", exact: true }).click();
  // (The row leaves the dialog as soon as the group's new member list arrives.)
  await expect(page.getByRole("status").filter({ hasText: `已添加${name}` })).toBeVisible();
  await dialog.getByRole("button", { name: "完成" }).click();
  await backToChat(page, title, profile);
}

/** 群资料 → the member named `name` → 移除 → 确认移除 (the creator only). */
export async function removeMemberUi(page, title, name) {
  const profile = await openGroupProfile(page, title);
  await profile.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "移除" }).click();
  await page.getByRole("dialog", { name: `移除${name}` }).getByRole("button", { name: "确认移除" }).click();
  await expect(page.getByRole("status").filter({ hasText: `已将${name}移出群聊` })).toBeVisible();
  await backToChat(page, title, profile);
}

/** Types `term` into the list's search box (contacts, conversations and, below them, 聊天记录). */
export async function searchEverywhere(page, term) {
  await goTo(page, "消息");
  await page.getByRole("searchbox", { name: "搜索联系人、群聊" }).fill(term);
}

/** A search hit (global, or in-chat with `scope` the chat) whose highlighted match is exactly `term`. */
export const hitFor = (page, term, scope = page) => scope.getByRole("button").filter({ has: page.getByText(term, { exact: true }) });

/** The scroll position of the open conversation's message list. */
export function scrollState(chat) {
  return messageList(chat).evaluate((list) => ({ top: list.scrollTop, fromBottom: list.scrollHeight - list.scrollTop - list.clientHeight }));
}

/** Contacts → the person's card. */
export async function openContact(page, name) {
  await goTo(page, "通讯录");
  await listRow(page, name).first().click();
  await expect(page.getByRole("region", { name: "联系人卡片" })).toBeVisible();
}

/** Settings → my profile → 退出登录; resolves on the sign-in screen. */
export async function signOutUi(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录 Haiyo" })).toBeVisible();
}

/** The sign-in screen, filled and submitted. */
export async function signInUi(page, { email, password }) {
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

// --- Agents ----------------------------------------------------------------------------------------------------------

/** The site models as the Agent form's model picker lists them (system.mjs `siteModels`). */
export const FREE_MODEL = "演示快速模型 · 免费";
export const PAID_MODEL = "演示高级模型 · 需余额";

/**
 * Picks a model in a form's model picker (src/pages/ModelSelect.jsx): its 模型 button opens a list (outside the form, at
 * the page's end), whose rows are named by their model's label and then their marks (“演示快速模型 · 免费 · 工具”); the
 * row whose name is `label`, or begins with it, is chosen.
 */
export async function chooseModelUi(page, form, label) {
  await form.getByLabel("模型", { exact: true }).click();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("listbox", { name: "模型" }).getByRole("option", { name: new RegExp(`^${escaped}(?: · |$)`) }).click();
}

/**
 * Picks an option of a form's plain choice (src/ui/Select.jsx, where a native <select> was): its button, labelled `label`,
 * opens a list of that name (outside the form, at the page's end); the option whose text is `option` is chosen.
 */
export async function chooseOptionUi(page, form, label, option) {
  await form.getByLabel(label, { exact: true }).click();
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option, exact: true }).click();
}

/**
 * Agent → 创建 Agent → the form (名称, the model picked by its label, optionally 简介, 擅长领域, 思考程度, 人格文档) →
 * 创建 Agent. `onFilled(form)` runs just before that click. Resolves with the Agent's conversation, which opens by itself.
 */
export async function createAgentUi(page, { name, model = FREE_MODEL, intro, field, reasoning, persona, onFilled }) {
  await goTo(page, "Agent");
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const form = page.getByRole("region", { name: "创建 Agent" });
  await form.getByLabel("名称", { exact: true }).fill(name);
  if (intro) await form.getByLabel("简介", { exact: true }).fill(intro);
  if (field) await form.getByLabel("擅长领域", { exact: true }).fill(field);
  await chooseModelUi(page, form, model);
  if (reasoning) await chooseOptionUi(page, form, "思考程度", reasoning);
  if (persona) await form.getByLabel("人格文档", { exact: true }).fill(persona);
  if (onFilled) await onFilled(form);
  await form.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const chat = chatPane(page, name);
  await expect(chat).toBeVisible();
  return chat;
}

/** Agent → the Agent named `name`: its 管理 page. */
export async function openAgentDetail(page, name) {
  await goTo(page, "Agent");
  await page.getByRole("button").filter({ has: page.getByText(name, { exact: true }) }).first().click();
  const detail = page.getByRole("region", { name: "Agent 管理" });
  await expect(detail.getByRole("heading", { name })).toBeVisible();
  return detail;
}

/** The reply being written in an Agent's conversation (none when no reply is under way). */
export const streamingBubble = (chat) => messageList(chat).locator("li.streaming");

/** The failed reply's status line at the end of an Agent's conversation. */
export const runStatusLine = (chat) => messageList(chat).locator("li.run-status");

/** The messages from the Agent (the stored ones) whose text contains `text`. */
export const agentMessagesWith = (chat, text) => messageList(chat).locator("li.msg.theirs:not(.streaming)").filter({ hasText: withTags(text) });

/** The open Agent conversation's 会话资料 → 开始新话题 → confirm; the panel is closed again. */
export async function newTopicUi(page, chat) {
  await chat.getByRole("button", { name: "会话资料" }).click();
  await page.getByRole("button", { name: "开始新话题" }).click();
  const dialog = page.getByRole("dialog", { name: "开始新话题" });
  await dialog.getByRole("button", { name: "开始新话题" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
}
