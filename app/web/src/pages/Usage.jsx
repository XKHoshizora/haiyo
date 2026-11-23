import React, { useCallback, useEffect, useRef, useState } from "react";
import { setShowReplyPoints, useShowReplyPoints } from "../data/prefs.js";
import { useStore } from "../data/store.jsx";
import { formatPoints } from "../data/viewmodel.js";
import { othersStateText } from "../data/othersCopy.js";
import { SETTINGS_PAGE_NAMES } from "../state/pageTitle.js";
import { Btn, KV, Reason, Switch, TextLink } from "../ui/primitives.jsx";
import { useOthersUse } from "./useOthersUse.js";

/** A reply has ended (its usage is settled): `run` statuses after which nothing more is charged. */
const ENDED = new Set(["done", "failed", "stopped", "cancelled"]);
const TIERS = { free: "免费档" };

const pad = (n) => String(n).padStart(2, "0");
/** An instant in the browser's local time: "11月17日 00:00". */
function localTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  return `${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Whether a balance (the service's decimal string) is below zero, read without arithmetic. */
const negative = (balance) => typeof balance === "string" && /^-\d*\.?\d*[1-9]/.test(balance.trim());

/**
 * Reads my usage when it is shown, and again after each reply of my Agents that ends while it is shown (the `run`
 * pushes reach the store; nothing is polled). Requests never overlap: one that ends asks again if needed.
 */
function useUsage() {
  const { state, actions } = useStore();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const again = useRef(false);
  const reload = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      let res;
      do {
        again.current = false;
        res = await actions.loadUsage();
      } while (again.current);
      setFailed(!res.ok);
    } finally {
      inFlight.current = false;
    }
  }, [actions]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The replies that have ended, as the store holds them: a run id with its end that was not there before is a new one.
  const ended = Object.values(state.convs)
    .filter((c) => c.run && ENDED.has(c.run.status))
    .map((c) => `${c.run.id}:${c.run.status}`)
    .sort()
    .join(" ");
  const seen = useRef(null);
  useEffect(() => {
    const now = ended ? ended.split(" ") : [];
    if (seen.current === null) {
      seen.current = new Set(now);
      return;
    }
    const fresh = now.filter((x) => !seen.current.has(x));
    for (const x of fresh) seen.current.add(x);
    if (fresh.length > 0) reload();
  }, [ended, reload]);

  return { usage: state.usage, failed, reload };
}

/**
 * 在每条回复下显示消耗的点数: a preference of this browser (data/prefs.js), off by default; my Agents' replies show
 * what each cost under them while it is on, in every open conversation at once.
 */
function ReplyPointsSwitch() {
  const on = useShowReplyPoints();
  return (
    <div className="reply-points">
      <Switch checked={on} onChange={(e) => setShowReplyPoints(e.target.checked)} label="在每条回复下显示消耗的点数" hint="只影响你这台设备上的显示。" hintClass="muted" />
    </div>
  );
}

/**
 * 别人的使用: one line of what others' use of my Agents has cost today (the service's numbers and state: `GET /api/me/others-use`) and the
 * way to the page where it is read in full and its two numbers are set. Without the line (not read yet, or not readable), the link alone.
 */
function OthersUseSection() {
  const { dispatch } = useStore();
  const { use } = useOthersUse();
  const open = (event) => {
    event.preventDefault();
    dispatch({ type: "nav", patch: { settingsPage: "others", pane: "main" } });
  };
  return (
    <section className="others-usage" aria-label="别人的使用">
      <h3>别人的使用</h3>
      {use && (
        <p>
          今天已回别人 {use.used.answers} 次，花了 {formatPoints(use.used.points)} 点 · {othersStateText(use)}
        </p>
      )}
      <p>
        <TextLink href="/settings/others" onClick={open}>
          {SETTINGS_PAGE_NAMES.others}
        </TextLink>
      </p>
    </section>
  );
}

/**
 * Settings › 用量与余额: today's free allowance and when it resets, the balance, the tier and the number of Agents,
 * and the last 7 days per Agent and model. Points are shown at the one display precision (`displayPoints`, data/viewmodel.js: no float arithmetic, values compared on the raw strings).
 * Below them, whether my Agents' replies show their points (`ReplyPointsSwitch`), whether or not the usage was read.
 * `back`: the settings back button (to the settings list on a phone).
 */
export function UsagePage({ back }) {
  const { state } = useStore();
  const { usage, failed, reload } = useUsage();

  // A row with no Agent is a call of mine of its own: reviewing what my Agents remember (purpose "memory"), else a persona draft.
  const agentName = (agentId, purpose) => {
    if (purpose === "memory") return "记忆";
    if (agentId === null || agentId === undefined) return "起草人格文档";
    const agent = state.agents[agentId];
    return agent && !agent.deleted ? agent.name : "已删除的 Agent";
  };
  const modelName = (row) => {
    if (row.source === "site") return `${state.siteModels.find((m) => m.id === row.model)?.label ?? row.model}（本站）`;
    if (row.source === "provider") return `${row.model}（我的供应商）`;
    return row.model;
  };

  let body;
  if (!usage) {
    body = failed ? (
      <Reason>
        没能读取用量，请重试。 <Btn small onClick={reload}>重试</Btn>
      </Reason>
    ) : (
      <p className="muted">正在读取用量…</p>
    );
  } else {
    const recent = usage.recent ?? [];
    // Web searches: a line of their own per Agent, after the models' (lane websearch2), never in a model's points.
    const recentWeb = usage.recentWeb ?? [];
    const resetsAt = usage.free?.resetsAt ? localTime(usage.free.resetsAt) : "";
    body = (
      <>
        {failed && (
          <Reason>
            没能读取最新的用量，下面是上次读到的。 <Btn small onClick={reload}>重试</Btn>
          </Reason>
        )}
        <h3>今日免费额度</h3>
        <KV
          rows={[
            ["已用 / 每日额度", `${usage.free?.usedText ?? ""} / ${usage.free?.allowanceText ?? ""} 点`],
            ["下次重置", resetsAt ? `${resetsAt}（本地时间）` : "—"],
            ...(usage.memory ? [["记忆今天的额度", `已用 ${usage.memory.usedText} / ${usage.memory.allowanceText} 点`]] : []),
          ]}
        />
        <p className="muted">免费模型先用今日免费额度，用完后从余额扣点；需余额的模型只从余额扣点。</p>

        <h3>余额</h3>
        <KV rows={[["当前余额", `${usage.balanceText} 点`]]} />
        {negative(usage.balance) && <p className="muted">余额为负：上一次回复超出了余额，下次发放时会先补平。</p>}
        <p className="muted">余额目前由本站管理员发放。</p>

        <h3>档位与 Agent 数量</h3>
        <KV
          rows={[
            ["档位", TIERS[usage.tier] ?? usage.tier],
            ["Agent 数量", `${usage.agentCount} / ${usage.agentLimit}`],
          ]}
        />

        <h3>最近用量</h3>
        <p className="muted">
          最近 7 天（含今天），按 Agent 和模型汇总。
          {state.webSearchAvailable === true || recentWeb.length > 0 ? "用你自己的供应商时，模型本身不扣点，联网搜索照样扣点。" : "用你自己的供应商不扣点。"}
          {recentWeb.length > 0 && "联网搜索单独列出。"}
        </p>
        {recent.length === 0 && recentWeb.length === 0 ? (
          <p className="muted">最近 7 天还没有用量。</p>
        ) : (
          <ul className="member-rows" aria-label="最近用量">
            {recent.map((r) => (
              <li key={`${r.agentId}|${r.purpose ?? ""}|${r.source}|${r.model}`}>
                <div className="member-body">
                  <strong>{agentName(r.agentId, r.purpose)}</strong>
                  <p>{modelName(r)}</p>
                </div>
                <span>{r.paidBy === "site" ? "由站点承担" : `${r.pointsText} 点${r.agentId ? ` · ${r.replies} 次回复` : ""}`}</span>
              </li>
            ))}
            {recentWeb.map((w) => (
              <li key={`web|${w.agentId}`}>
                <div className="member-body">
                  <strong>{agentName(w.agentId, "reply")}</strong>
                  <p>联网搜索</p>
                </div>
                <span>{`${w.pointsText} 点 · ${w.searches} 次`}</span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="page" aria-label="用量与余额">
      {back}
      <header className="profile-head">
        <div>
          <h2>用量与余额</h2>
        </div>
      </header>
      <div className="page-body">
        {body}
        <OthersUseSection />
        <ReplyPointsSwitch />
      </div>
    </section>
  );
}
