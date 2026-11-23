import React, { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText, socialErrorText } from "../data/errorTexts.js";
import { formatPoints } from "../data/viewmodel.js";
import { ANSWERS_WRONG, answersOf } from "../data/othersLimits.js";
import { othersStateOf, othersStateText } from "../data/othersCopy.js";
import { SETTINGS_PAGE_NAMES } from "../state/pageTitle.js";
import { Avatar, Btn, Reason } from "../ui/primitives.jsx";
import { isEnter } from "../ui/keys.js";
import { budgetOf } from "./AgentForm.jsx";
import { useOthersUse } from "./useOthersUse.js";

const POINTS_WRONG = "请填写 1 到 100000 之间的点数（最多 6 位小数）";

/**
 * 「别人每天最多让我的 Agent 回复 [50] 次，最多花我 [70] 点」: the owner's two numbers, each edited in place and saved together on Enter or
 * when a box loses the focus (only when what is typed is a number of its kind and differs from what is stored). One pair for the
 * owner, shared by all their Agents; the service decides, and its refusal is said under the sentence.
 */
function LimitSentence({ limits, onSave }) {
  const hintId = useId();
  const [answers, setAnswers] = useState(String(limits.answers));
  const [points, setPoints] = useState(limits.points);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // What the service says is what the boxes show again (after a save, or a change on another device).
  useEffect(() => {
    setAnswers(String(limits.answers));
    setPoints(limits.points);
  }, [limits.answers, limits.points]);

  const commit = async () => {
    if (saving) return;
    const nextAnswers = answersOf(answers);
    const nextPoints = budgetOf(points);
    if (nextAnswers === null || nextAnswers === undefined) return setError(ANSWERS_WRONG);
    if (nextPoints === null) return setError(POINTS_WRONG);
    setError("");
    if (nextAnswers === limits.answers && nextPoints === budgetOf(limits.points)) return;
    setSaving(true);
    try {
      await onSave({ answers: nextAnswers, points: nextPoints });
    } catch (err) {
      setError(commonErrorText(err));
    } finally {
      setSaving(false);
    }
  };
  const keys = (event) => {
    if (!isEnter(event)) return;
    event.preventDefault();
    commit();
  };
  return (
    <div className="others-limit-sentence">
      <p>
        <span>别人每天最多让我的 Agent 回复</span>
        <input
          className="others-number"
          aria-label="每天最多回复的次数"
          aria-describedby={hintId}
          aria-invalid={error && answersOf(answers) === undefined ? true : undefined}
          inputMode="numeric"
          autoComplete="off"
          value={answers}
          onChange={(e) => setAnswers(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
        <span>次，最多花我</span>
        <input
          className="others-number"
          aria-label="每天最多花的点数"
          aria-describedby={hintId}
          aria-invalid={error && budgetOf(points) === null ? true : undefined}
          inputMode="decimal"
          autoComplete="off"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
        <span>点</span>
      </p>
      {error && <p className="field-msg" role="alert">{error}</p>}
      <p id={hintId} className="field-hint">你所有的 Agent 加在一起算，没人叫它时的主动回复也算在里面；每天零点（站点时间）重新计算。</p>
    </div>
  );
}

/** One person who used my Agents today, with 停止往来 while Agent social is on (the site's switch); nothing more of them than the route says. */
function PersonRow({ row, social, onStop, pending, error }) {
  const { person } = row;
  return (
    <li>
      <Avatar id={person.id} size={40} />
      <div className="member-body">
        <strong>{person.displayName}</strong>
        <p className="muted">@{person.handle} · 回了 {row.answers} 次，花了 {formatPoints(row.points)} 点</p>
        {error && <p className="field-msg" role="alert">{error}</p>}
      </div>
      {social && (
        <div className="member-actions">
          <Btn small disabled={pending} aria-label={`停止往来：${person.displayName}`} onClick={() => onStop(person)}>
            停止往来
          </Btn>
        </div>
      )}
    </li>
  );
}

/**
 * Settings › 别人怎么用我的 Agent: my two daily numbers (edited in place), today's use against them with its state (正常 / 快用完了… /
 * 今天的额度用完了, the service's `reached` and `tight`, worded in data/othersCopy.js), each Agent's own line, who used them today and,
 * while the site's Agent social switch is on, 停止往来 on each of them and the list of those stopped with 恢复往来. Nothing here is
 * computed: every number, state and list is what `GET /api/me/others-use` says, and the page exists for its owner alone.
 */
export function OthersUsePage({ back }) {
  const { state, actions } = useStore();
  const { use, failed, reload, settle } = useOthersUse();
  const social = state.social?.enabled === true;
  const [pending, setPending] = useState(null);
  const [rowError, setRowError] = useState({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const save = async (body) => {
    const limits = await actions.putOthersLimits(body);
    if (!alive.current) return;
    if (use && limits && typeof limits.answers === "number") settle({ ...use, limits });
    await reload();
  };
  /** 停止往来 or 恢复往来 with one person: the route, then the page as it stands now. A refusal is said under that person. */
  const move = async (person, stop) => {
    if (pending !== null) return;
    setPending(person.id);
    setRowError((cur) => ({ ...cur, [person.id]: "" }));
    try {
      if (stop) await actions.putBar(person.id);
      else await actions.deleteBar(person.id);
      await reload();
    } catch (err) {
      if (alive.current) setRowError((cur) => ({ ...cur, [person.id]: socialErrorText(err) }));
    } finally {
      if (alive.current) setPending(null);
    }
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
    const overall = othersStateOf(use);
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
          已回 {use.used.answers} 次，花了 {formatPoints(use.used.points)} 点
          <span className={`others-state others-state-${overall}`}> · {othersStateText(use)}</span>
        </p>

        <h3>每个 Agent</h3>
        {agents.length === 0 ? (
          <p className="muted">你还没有可以回复别人的 Agent。</p>
        ) : (
          <ul className="member-rows others-agents" aria-label="每个 Agent">
            {agents.map((a) => (
              <li key={a.agentId}>
                <div className="member-body">
                  <strong>{nameOfAgent(a.agentId)}：以这个数，每天大约能回别人 {a.perDay} 次</strong>
                  <p className="muted">
                    今天回了 {a.answers} 次，花了 {formatPoints(a.points)} 点
                    <span className={`others-state others-state-${othersStateOf(a)}`}> · {othersStateText(a)}</span>
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
          <ul className="member-rows others-people" aria-label="今天用过你的 Agent 的人">
            {byPerson.map((row) => (
              <PersonRow key={row.person.id} row={row} social={social} pending={pending !== null} error={rowError[row.person.id]} onStop={(person) => move(person, true)} />
            ))}
          </ul>
        )}

        {(social || stopped.length > 0) && (
          <>
            <h3>已停止往来的人</h3>
            <p className="muted">停止往来的人不能再找你的 Agent。恢复往来后，对方可以重新申请。</p>
            {stopped.length === 0 ? (
              <p className="muted">你没有停止过和谁的往来。</p>
            ) : (
              <ul className="member-rows others-stopped" aria-label="已停止往来的人">
                {stopped.map((row) => (
                  <li key={row.person.id}>
                    <Avatar id={row.person.id} size={40} />
                    <div className="member-body">
                      <strong>{row.person.displayName}</strong>
                      <p className="muted">@{row.person.handle}</p>
                      {rowError[row.person.id] && <p className="field-msg" role="alert">{rowError[row.person.id]}</p>}
                    </div>
                    {social && (
                      <div className="member-actions">
                        <Btn small disabled={pending !== null} aria-label={`恢复往来：${row.person.displayName}`} onClick={() => move(row.person, false)}>
                          恢复往来
                        </Btn>
                      </div>
                    )}
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
