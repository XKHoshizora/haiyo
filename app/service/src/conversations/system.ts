import type { Queryable, Tx } from "../db.ts";
import { insertMessage, type StoredMessage, type SystemEvent } from "../messages/model.ts";

const LISTED_NAMES = 10;

function idsIn(e: SystemEvent): string[] {
  const ids = [e.actorId];
  if ("principalId" in e) ids.push(e.principalId);
  if ("newCreatorId" in e && e.newCreatorId) ids.push(e.newCreatorId);
  if ("memberIds" in e) ids.push(...e.memberIds.slice(0, LISTED_NAMES));
  if ("agentId" in e) ids.push(e.agentId);
  if ("agentIds" in e) ids.push(...e.agentIds);
  if ("ownerIds" in e) ids.push(...e.ownerIds);
  return ids;
}

/**
 * The Chinese sentence for a notice in conversation `conversationId`, with display names as they are now. Clients may
 * re-render from the event.
 */
export async function renderNotice(q: Queryable, conversationId: string, e: SystemEvent): Promise<string> {
  const { rows } = await q.query<{ id: string; display_name: string }>(
    "select id, display_name from principals where id = any($1::uuid[])",
    [idsIn(e)],
  );
  const names = new Map(rows.map((r) => [r.id, r.display_name]));
  const n = (id: string) => names.get(id) ?? "某人";
  switch (e.event) {
    case "group_created": {
      const listed = e.memberIds.slice(0, LISTED_NAMES).map(n).join("、");
      const more = e.memberIds.length > LISTED_NAMES ? `等${e.memberIds.length}人` : "";
      return `${n(e.actorId)}创建了群聊「${e.title}」，并邀请${listed}${more}加入`;
    }
    case "member_joined":
      return `${n(e.actorId)}邀请${n(e.principalId)}加入了群聊`;
    case "member_left":
      return `${n(e.principalId)}退出了群聊${e.newCreatorId ? `，${n(e.newCreatorId)}成为新的创建者` : ""}`;
    case "member_removed":
      return `${n(e.actorId)}将${n(e.principalId)}移出了群聊`;
    case "group_renamed":
      return `${n(e.actorId)}将群名改为「${e.title}」`;
    case "friendship_ended":
      return `${n(e.actorId)}解除了与${n(e.principalId)}的好友关系，双方不能再发送新消息，已有历史不受影响`;
    case "friendship_restored":
      return `${n(e.actorId)}和${n(e.principalId)}重新成为好友，可以继续发送消息`;
    case "blocked":
      return `${n(e.actorId)}拉黑了${n(e.principalId)}，只能由对方解除。双方不能再发送新消息，已有历史不受影响`;
    case "unblocked":
      return `${n(e.actorId)}解除了对${n(e.principalId)}的拉黑`;
    case "topic_reset": {
      // The Agent is the conversation's: its name as it is now.
      const agent = await q.query<{ display_name: string }>(
        "select p.display_name from agent_conversations ac join principals p on p.id = ac.agent_id where ac.conversation_id = $1",
        [conversationId],
      );
      return `${n(e.actorId)} 开始了新话题，之前的对话不再发给 ${agent.rows[0]?.display_name ?? "某人"}`;
    }
    // Only a title: what changed travels in the event, to the owner's client alone (messages/read.ts).
    case "memory_changed":
      return "记忆已更新";
    case "agents_halted":
      return `${n(e.actorId)} 让 Agent 停止了接话`;
    case "agent_chain_paused":
      return `Agent 已连续对话 ${e.limit} 条，已暂停互相接话，有人发言后继续。`;
    case "agent_budget_reached":
      return `${n(e.agentId)} 已达到本次接话的点数上限，有人发言后继续。`;
    // To the owner, in the Agent's own conversation: the number as it was then (decimal points), and that replies under way finish.
    case "others_limit_reached":
      return `别人今天用你的 Agent 已经花到每天上限 ${e.points} 点，今天不再回复别人；已经在回复的会照常回完。`;
    case "agent_quieted":
      return `「${n(e.agentId)}」暂时不主动发言，需要时可以 @ 一下`;
    // The disclosure of a social conversation (system UI text, in no Agent's voice): who watches it. Two owners: their names joined by 、.
    case "social_opened": {
      const owners = e.ownerIds.map(n).join("、");
      return `这是${owners}的 Agent。${owners}能看到你们的对话，也可能插话。`;
    }
    // Only a title: the card's details travel in the event, to the owner's client alone (ring 1a).
    case "persona_fact":
      return "人格里有句话可能被说给别人";
  }
}

/**
 * Appends a system notice. Always allowed, even where nobody may send. The caller must hold the
 * conversation row lock (and, in a direct conversation, the pair lock before it).
 */
export async function appendSystem(t: Tx, conversationId: string, e: SystemEvent): Promise<StoredMessage> {
  const text = await renderNotice(t, conversationId, e);
  // A memory notice always says which tier wrote it and how many lines it has (a web client words its sentence from them).
  const stored = e.event === "memory_changed" ? { ...e, phase: e.phase ?? "rest", count: e.count ?? e.lines.length } : e;
  return insertMessage(t, conversationId, e.actorId, "system", { ...stored, text }, null);
}
