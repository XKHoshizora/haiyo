// A reply whose run searched the web (lane websearch), in a real browser against the real service — with no engine and
// the site's web search left off (the shared service's configuration is every spec's): the model stub writes a reply with
// a Markdown link and a bare address, and the spec gives that stored reply what a web reply keeps beside its text
// (`webSources`, `webCites`) straight in the database (support/db.mjs `addWebSources`). Reloaded, the reply's text opens
// nothing — its link and its bare address are plain text — and only its sources list and its chip open pages, in a new tab
// with rel="noopener noreferrer nofollow"; a reply without sources keeps its link as a link.
import { test, expect } from "./support/fixtures.mjs";
import { uniq } from "./support/accounts.mjs";
import { agentMessagesWith, openChat, sendText } from "./support/app.mjs";
import { canControlService } from "./support/control.mjs";
import { addWebSources } from "./support/db.mjs";
import { modelStub } from "./support/model-stub.mjs";
import { agentApi } from "./support/tools.mjs";

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its database");
  await modelStub.reset();
});

const SOURCES = [
  { n: 1, url: "https://news.example.com/a/1", title: "北京明天晴" },
  { n: 2, url: "https://weather.example.org/b", title: "气象台：明天降温" },
];

/** The seq of Agent `agentId`'s reply in `conversationId` whose text holds `tag`, read as its owner reads it. */
async function replySeq(person, agentId, conversationId, tag) {
  const res = await person.request.get(`/api/conversations/${conversationId}/messages`);
  expect(res.status()).toBe(200);
  const found = (await res.json()).messages.find((m) => m.senderId === agentId && m.text.includes(tag));
  expect(found, "the reply is stored").toBeTruthy();
  return found.seq;
}

test("a web reply's own link and bare address are plain text; only its sources and its chip open pages, safely", async ({ people }) => {
  const ann = await people.member("Ann");
  const agent = await agentApi(ann, { name: `网页${uniq(4)}` });
  const tag = uniq(6);
  const plainTag = uniq(6);
  const text = (t) => `见[详情](https://evil.example/?d=1) 或 https://bare.example/x 。${t}`;
  const chat = await openChat(ann.page, agent.name);

  // A reply that will be given sources, and one that will not.
  await modelStub.reply(text(tag));
  await sendText(ann.page, agent.name, `明天天气？${tag}`);
  await expect(agentMessagesWith(chat, tag)).toHaveCount(1);
  await modelStub.reply(text(plainTag));
  await sendText(ann.page, agent.name, `再说一次？${plainTag}`);
  await expect(agentMessagesWith(chat, plainTag)).toHaveCount(1);

  const seq = await replySeq(ann, agent.id, agent.conversationId, tag);
  await addWebSources(agent.conversationId, seq, SOURCES, [{ at: 1, n: 2 }]);
  await ann.page.reload();
  const again = await openChat(ann.page, agent.name);

  const web = agentMessagesWith(again, tag);
  await expect(web).toHaveCount(1);
  // Rendered (the Markdown tree, where links would be links), and none of its text's links is one.
  await expect(web.locator(".bubble .md")).toHaveCount(1);
  await expect(web.locator(".bubble")).toContainText("详情");
  await expect(web.locator(".bubble")).toContainText("evil.example");
  await expect(web.locator(".bubble a:not(.cite-link)")).toHaveCount(0);
  // Its one chip opens the page it cites.
  const chip = web.locator(".bubble a.cite-link");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("网2");
  await expect(chip).toHaveAttribute("href", SOURCES[1].url);
  await expect(chip).toHaveAttribute("target", "_blank");
  await expect(chip).toHaveAttribute("rel", "noopener noreferrer nofollow");
  // Its sources, under its lookup line: the title and the address's real host, each opening a new tab.
  await expect(web.locator(".msg-lookups")).toHaveText("查了 1 次网页");
  const rows = web.locator("ol.web-sources li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("北京明天晴");
  await expect(rows.nth(0)).toContainText("news.example.com");
  await expect(web.locator('ol.web-sources a[target="_blank"][rel="noopener noreferrer nofollow"]')).toHaveCount(2);

  // The reply without sources keeps its link a link.
  const plain = agentMessagesWith(again, plainTag);
  await expect(plain.locator(".bubble .md")).toHaveCount(1);
  await expect(plain.locator('.bubble a[href="https://evil.example/?d=1"]')).toHaveCount(1);
  await expect(plain.locator("ol.web-sources")).toHaveCount(0);
});
