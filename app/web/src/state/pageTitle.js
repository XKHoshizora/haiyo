// What the page a person is on is called: the tab's title (`document.title`, also each history entry's name) and what a screen
// reader hears when the page changes without the focus moving. Front-loaded — the page first, then where it is, then the product:
// 「小安 · 消息 · Haiyo」, 「模型供应商 · 设置 · Haiyo」. Made from the names the pages already show, nothing new.
import { titled } from "../brand.js";
import { convTitle, entity, nameOf } from "./selectors.js";

export const SECTION_NAMES = { chat: "消息", contacts: "通讯录", agents: "Agent", settings: "设置" };
/** The settings pages, as their rows in the settings list name them (pages/Settings.jsx draws the rows from here). */
export const SETTINGS_PAGE_NAMES = { profile: "我的资料", providers: "模型供应商", usage: "用量与余额", memory: "记忆宫殿", blocks: "拉黑" };

/** The parts of the page's name, the page first (the product's name is not among them). */
function partsOf(state) {
  const nav = state.nav;
  const section = SECTION_NAMES[nav.section] ?? SECTION_NAMES.chat;
  if (nav.pane !== "main") return [section];
  switch (nav.section) {
    case "contacts": {
      const who = nav.contactId && entity(state, nav.contactId);
      return who ? [nameOf(state, nav.contactId), section] : [section];
    }
    case "agents": {
      if (nav.agentView === "create") return ["创建 Agent", section];
      const agent = nav.agentId && state.agents?.[nav.agentId];
      if (!agent) return [section];
      return [nav.agentView === "edit" ? `编辑 ${agent.name}` : agent.name, section];
    }
    case "settings": {
      const page = SETTINGS_PAGE_NAMES[nav.settingsPage] ?? SETTINGS_PAGE_NAMES.profile;
      if (nav.settingsPage === "providers" && nav.providerId) {
        const provider = state.providers?.[nav.providerId];
        return [nav.providerId === "new" || !provider ? "添加供应商" : `编辑 ${provider.name}`, page, section];
      }
      return [page, section];
    }
    default: {
      const conv = state.convs[nav.convId];
      if (!conv) return [section];
      const title = convTitle(state, conv);
      if (nav.view === "profile") return ["群资料", title];
      if (nav.detailsOpen) return ["会话资料", title];
      return [title, section];
    }
  }
}

/** `{label, title}`: what the page is called (announced), and the tab's title (with the product's name). */
export function pageTitle(state) {
  const label = partsOf(state).join(" · ");
  return { label, title: titled(label) };
}

