// What a message's menu offers (ui/BubbleMenu.jsx): only what the app already does, plus copy. Each action is `{id, label, icon, run}`.
import { mentionSegments } from "../data/mentions.js";
import { entity } from "../state/selectors.js";
import { Copy, Download, Reply } from "../icons.js";

/** A message's text as plain text: a mention as `@` and the name it shows now (a gone one as it was sent), no hidden words. */
export function plainText(state, msg) {
  return mentionSegments(msg.text ?? "", msg.mentions)
    .map((part) => {
      if (!part.mention) return part.text;
      const known = entity(state, part.mention.id);
      return known ? `@${known.displayName || known.name}` : part.text;
    })
    .join("");
}

/** Puts `text` on the clipboard (the async API, else a hidden field and `execCommand`); resolves with whether it worked. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // (Falls through to the old way.)
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(field);
  field.select();
  let done = false;
  try {
    done = document.execCommand?.("copy") ?? false;
  } catch {
    done = false;
  }
  field.remove();
  return done;
}

/** Downloads `url` as `name`: a link that is pressed, so nothing navigates and the page stays as it is. */
function save(url, name) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The actions of `msg`: 回复 (a text or a picture that is stored), 复制 (a text), 保存图片 (a picture), 下载 (a file that
 * can be fetched). `onReply(msg)` quotes it; `dispatch` shows the toast.
 */
export function messageActions({ state, dispatch, msg, onReply }) {
  const out = [];
  const stored = msg.seq !== null && msg.status !== "failed" && msg.status !== "sending";
  if ((msg.kind === "text" || msg.kind === "image") && stored) out.push({ id: "reply", label: "回复", icon: Reply, run: () => onReply(msg) });
  if (msg.kind === "text" && plainText(state, msg).trim() !== "") {
    out.push({
      id: "copy",
      label: "复制",
      icon: Copy,
      run: async () => dispatch({ type: "toast", text: (await copyText(plainText(state, msg))) ? "已复制" : "没能复制，请再试一次" }),
    });
  }
  if (msg.kind === "image" && msg.src) out.push({ id: "save", label: "保存图片", icon: Download, run: () => save(msg.src, msg.text) });
  if (msg.kind === "file" && msg.attachment?.url && !msg.upload) out.push({ id: "download", label: "下载", icon: Download, run: () => save(msg.attachment.url, msg.text) });
  return out;
}
