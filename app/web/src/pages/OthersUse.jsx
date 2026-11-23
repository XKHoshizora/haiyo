import React, { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText } from "../data/errorTexts.js";
import { formatPoints } from "../data/viewmodel.js";
import { ANSWERS_WRONG, answersOf } from "../data/othersLimits.js";
import { othersStateOf, othersStateText } from "../data/othersCopy.js";
import { SETTINGS_PAGE_NAMES } from "../state/pageTitle.js";
import { Avatar, Btn, Reason, TextLink } from "../ui/primitives.jsx";
import { isEnter } from "../ui/keys.js";
import { budgetOf } from "./AgentForm.jsx";
import { useOthersUse } from "./useOthersUse.js";

const POINTS_WRONG = "点数请填 1 到 100000 的数";

/**
 * 「别人每天最多让我的 Agent 回复 [50] 次，最多花我 [300] 点」: the owner's two numbers. Each box owns its draft: a number typed (or being
 * typed) is never overwritten by an answer of the service, only a box nobody has touched follows the stored number. A box is saved, with the
 * other as it is shown, on Enter or when it loses the focus, and only when both are numbers of their kind (anything else is refused in
 * place, under the sentence, and nothing is sent). Saves go one at a time: one asked for during another runs when that ends, with what is
 * shown by then, so none is dropped and what is stored is what the boxes show.
 */
function LimitSentence({ limits, onSave }) {
  const hintId = useId();
  const [answers, setAnswers] = useState(String(limits.answers));
  const [points, setPoints] = useState(limits.points);
  const [error, setError] = useState({ field: null, text: "" });
  const dirty = useRef({ answers: false, points: false });
  const shown = useRef({ answers, points });
  shown.current = { answers, points };
  /** What the service holds, as last known: the saved numbers (before the page has read them again) or the page's. */
  const stored = useRef({ answers: limits.answers, points: limits.points });
  const running = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // What the service says follows only a box nobody has touched.
  useEffect(() => {
    stored.current.answers = limits.answers;
    if (!dirty.current.answers) setAnswers(String(limits.answers));
  }, [limits.answers]);
  useEffect(() => {
    stored.current.points = limits.points;
    if (!dirty.current.points) setPoints(limits.points);
  }, [limits.points]);

  const once = async () => {
    const draft = { ...shown.current };
    const a = answersOf(draft.answers);
    const p = budgetOf(draft.points);
    if (a === null || a === undefined) return setError({ field: "answers", text: ANSWERS_WRONG });
    if (p === null) return setError({ field: "points", text: POINTS_WRONG });
    setError({ field: null, text: "" });
    const same = a === stored.current.answers && p === budgetOf(stored.current.points);
    if (!same) {
      try {
        await onSave({ answers: a, points: p });
        stored.current = { answers: a, points: p };
      } catch (err) {
        if (alive.current) setError({ field: null, text: commonErrorText(err) });
        return;
      }
    }
    // A box that still holds what was just sent is nobody's draft any more (it follows the service again); one typed in since stays.
    if (shown.current.answers === draft.answers) {
      dirty.current.answers = false;
      if (alive.current) setAnswers(String(a));
    }
    if (shown.current.points === draft.points) {
      dirty.current.points = false;
      if (alive.current) setPoints(p);
    }
  };
  const commit = async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        await once();
      } while (again.current && alive.current);
    } finally {
      running.current = false;
    }
  };
  const keys = (event) => {
    if (!isEnter(event)) return;
    event.preventDefault();
    commit();
  };
  const box = (field, value, setValue, label, mode) => (
    <input
      className="others-number"
      aria-label={label}
      aria-describedby={hintId}
      aria-invalid={error.field === field ? true : undefined}
      inputMode={mode}
      autoComplete="off"
      value={value}
      onChange={(e) => {
        dirty.current[field] = true;
        setValue(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={keys}
    />
  );
  return (
    <div className="others-limit-sentence">
      <p>
        <span>别人每天最多让我的 Agent 回复</span>
        <span className="others-unit">
          {box("answers", answers, setAnswers, "每天最多回复的次数", "numeric")}
          <span>次，</span>
        </span>
        <span>最多花我</span>
        <span className="others-unit">
          {box("points", points, setPoints, "每天最多花的点数", "decimal")}
          <span>点</span>
        </span>
      </p>
      {error.text && <p className="field-msg" role="alert">{error.text}</p>}
      <p id={hintId} className="field-hint">你所有的 Agent 合在一起算，它们主动说的话也算。每天零点重新算。</p>
    </div>
  );
}

/** "11月5日" in the browser's own time. */
function sinceText(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

/**
 * A person on this page: their name is a link to their profile, where 停止往来 and 恢复往来 live (one place for that act, with its question
 * and its words). This page has no such control of its own.
 */
function PersonLink({ person }) {
  const { dispatch } = useStore();
  const open = (event) => {
    event.preventDefault();
    dispatch({ type: "nav", patch: { section: "contacts", contactId: person.id, pane: "main" } });
  };
  return (
    <TextLink href={`/contacts/${encodeURIComponent(person.id)}`} onClick={open}>
      {person.displayName}
    </TextLink>
  );
}

/**
 * Settings › 别人怎么用我的 Agent: my two daily numbers (edited in place), today's use against them with its state (正常 / 余量不多… / 别人今天的
 * 额度已用完, the service's `reached` and `tight`, worded in data/othersCopy.js), each Agent's own line, who used them today and who is
 * stopped. Nothing here is computed: every number, state and list is what `GET /api/me/others-use` says, and the page exists for its owner alone.
 * It never stops or resumes anyone: that is done on the person's profile.
 */
export function OthersUsePage({ back }) {
  const { state, actions } = useStore();
  const { use, failed, reload, settle } = useOthersUse();
  const save = async (body) => {
    const limits = await actions.putOthersLimits(body);
    if (use && limits && typeof limits.answers === "number") settle({ ...use, limits });
    await reload();
  };

  let body;
  if (!use) {
    body = failed ? (
      <Reason>
        没能读取，请重试。 <Btn small onClick={reload}>重试</Btn>
      </Reason>
    ) : (
      <p className="muted">正在读取…</p>
    );
  } else {
    const stopped = Array.isArray(use.stopped) ? use.stopped : [];
    const byPerson = Array.isArray(use.byPerson) ? use.byPerson : [];
    const agents = Array.isArray(use.agents) ? use.agents : [];
    const nameOfAgent = (id) => state.agents[id]?.name ?? "Agent";
    const proactive = use.used.proactivePoints;
    body = (
      <>
        {failed && (
          <Reason>
            没能读取最新的，下面是上次读到的。 <Btn small onClick={reload}>重试</Btn>
          </Reason>
        )}
        <LimitSentence limits={use.limits} onSave={save} />

        <h3>今天</h3>
        <p className="others-today">
          已回别人 {use.used.answers} 次，花了 {formatPoints(use.used.points)} 点
          {typeof proactive === "string" && formatPoints(proactive) !== "0" && `（其中主动回复 ${formatPoints(proactive)} 点）`}
          <span className={`others-state others-state-${othersStateOf(use)}`}> · {othersStateText(use)}</span>
        </p>

        <h3>每个 Agent</h3>
        {agents.length === 0 ? (
          <p className="muted">你还没有可以回复别人的 Agent。</p>
        ) : (
          <ul className="member-rows others-agents" aria-label="每个 Agent">
            {agents.map((a) => (
              <li key={a.agentId}>
                <div className="member-body">
                  <p>
                    <strong>{nameOfAgent(a.agentId)}</strong>
                    {a.canReply === false ? "：现在没有可用的模型，不回别人" : `：只有它在回的话，每天大约能回 ${a.perDay} 次`}
                  </p>
                  <p className="muted">
                    今天回了 {a.answers} 次，花了 {formatPoints(a.points)} 点
                    {a.canReply !== false && <span className={`others-state others-state-${othersStateOf(a)}`}> · {othersStateText(a)}</span>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>今天谁用了</h3>
        {byPerson.length === 0 ? (
          <p className="muted">今天还没有别人用过你的 Agent。</p>
        ) : (
          <>
            <p className="muted">点名字，到对方的资料页，可以在那里停止往来。</p>
            <ul className="member-rows others-people" aria-label="今天用过你的 Agent 的人">
              {byPerson.map((row) => (
                <li key={row.person.id}>
                  <Avatar id={row.person.id} size={40} />
                  <div className="member-body">
                    <strong><PersonLink person={row.person} /></strong>
                    <p className="muted">@{row.person.handle} · 回了对方 {row.answers} 次，花了 {formatPoints(row.points)} 点</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {(state.social?.enabled === true || stopped.length > 0) && (
          <>
            <h3>已停止往来的人</h3>
            <p className="muted">停止往来后，你们各自的 Agent 都不再回应对方。恢复往来后，已经停下的对话不会自己回来，想再聊要重新申请。在对方的资料页可以恢复往来。</p>
            {stopped.length === 0 ? (
              <p className="muted">现在没有停止往来的人。</p>
            ) : (
              <ul className="member-rows others-stopped" aria-label="已停止往来的人">
                {stopped.map((row) => (
                  <li key={row.person.id}>
                    <Avatar id={row.person.id} size={40} />
                    <div className="member-body">
                      <strong><PersonLink person={row.person} /></strong>
                      <p className="muted">@{row.person.handle} · 自 {sinceText(row.since)} 起</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <section className="page others-use" aria-label={SETTINGS_PAGE_NAMES.others}>
      {back}
      <header className="profile-head">
        <div>
          <h2>{SETTINGS_PAGE_NAMES.others}</h2>
          <p className="muted">别人和你的 Agent 聊天、在群里叫它，花的点都算在你这里。</p>
        </div>
      </header>
      <div className="page-body">{body}</div>
    </section>
  );
}
