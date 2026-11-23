import React, { useEffect, useId, useRef, useState } from "react";
import { SETTINGS_PAGE_NAMES } from "../state/pageTitle.js";
import { useUp } from "../state/appHistory.js";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { dayText, profileErrorText } from "../data/errorTexts.js";
import { displayName as displayNameProblem, handle as handleProblem } from "../auth/validation.js";
import { entity, nameOf } from "../state/selectors.js";
import { Avatar, Btn, Field, KV, Reason, Switch, Tag } from "../ui/primitives.jsx";
import { ListHeader } from "./ChatList.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { AvatarEditor } from "./AvatarEditor.jsx";
import { ProvidersPage } from "./Providers.jsx";
import { UsagePage } from "./Usage.jsx";
import { OthersUsePage } from "./OthersUse.jsx";
import { ChevronLeft, ChevronRight } from "../icons.js";
import { usePhone } from "../ui/pointer.js";
import { useSession } from "../auth/AuthRoot.jsx";
import { MemoryRoom, useMemoryRoom } from "./MemoryRoom.jsx";
import { MEMORY_LANGUAGES, languageName } from "../data/memoryLanguages.js";
import { PROVIDERS_PAGE, choiceList, modelKey, pickerGroups, staleRows, useModelSources } from "./ModelPicker.jsx";
import { ModelSelect } from "./ModelSelect.jsx";
import { Select } from "../ui/Select.jsx";
import { refusalText, settled, useAction } from "./useAction.js";
import { LEGAL_LINK_NAMES, LEGAL_PATHS } from "../legal/docs.js";

/** The rows under 关于: each public page and what it is about. */
const LEGAL_ROWS = [
  ["terms", "使用规则、18 岁以上"],
  ["privacy", "保存什么、交给谁、保存多久"],
  ["contact", "support@haiyo.org、举报"],
];

/** What signs the account out (the profile page's button, and the 设置 list on a phone): null outside the sign-in gate. */
function useSignOut() {
  const { dispatch } = useStore();
  const session = useSession();
  if (!session) return null;
  return async () => {
    const result = await session.signOut();
    if (!result.ok) dispatch({ type: "toast", text: "退出登录失败，请检查网络后重试" });
  };
}

/** A settings entry: a row of the list's own style, its chevron saying that it opens. With `href` it is a link to a public page, in a new tab. */
function SettingsRow({ name, note, onOpen, href }) {
  const body = (
    <>
      <span className="row-body">
        <span className="row-name">{name}</span>
        <span className="row-preview">{note}</span>
      </span>
      <ChevronRight className="row-chevron" size={18} aria-hidden="true" />
    </>
  );
  return (
    <li>
      {href ? (
        <a className="row slim" href={href} target="_blank" rel="noopener">{body}</a>
      ) : (
        <button type="button" className="row slim" onClick={onOpen}>{body}</button>
      )}
    </li>
  );
}

export function SettingsList() {
  const { state, dispatch } = useStore();
  const phone = usePhone();
  const signOut = useSignOut();
  const self = entity(state, ME) || { name: "", handle: "" };
  const open = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });
  return (
    <>
      <ListHeader title="设置" />
      <div className="settings-me">
        <Avatar id={ME} size={56} online />
        <div>
          <strong>{state.account?.displayName ?? ""}</strong>
          <p className="muted">{self.handle} · 真人账户</p>
        </div>
      </div>
      <ul className="rows">
        <SettingsRow name={SETTINGS_PAGE_NAMES.profile} note="昵称、头像与账户" onOpen={() => open({ settingsPage: "profile" })} />
        <SettingsRow name={SETTINGS_PAGE_NAMES.providers} note="你自己的模型服务账号与密钥" onOpen={() => open({ settingsPage: "providers" })} />
        <SettingsRow name={SETTINGS_PAGE_NAMES.usage} note="今日免费额度、余额与最近用量" onOpen={() => open({ settingsPage: "usage" })} />
        <SettingsRow name={SETTINGS_PAGE_NAMES.others} note="别人每天最多能花你多少点" onOpen={() => open({ settingsPage: "others" })} />
        <SettingsRow name={SETTINGS_PAGE_NAMES.memory} note="记住的关于你的事，可以在这里整理" onOpen={() => open({ settingsPage: "memory" })} />
        <SettingsRow name={SETTINGS_PAGE_NAMES.blocks} note="你拉黑的人和 Agent，可在这里解除" onOpen={() => open({ settingsPage: "blocks" })} />
        {/* (A phone has no profile page open beside this list: the way out of the account is here.) */}
        {phone && signOut && (
          <li>
            <button type="button" className="row slim danger-row" onClick={signOut}>
              <span className="row-body">
                <span className="row-name">退出登录</span>
              </span>
            </button>
          </li>
        )}
        {/* The public pages (src/legal/), in a new tab: the app stays where it was. */}
        <li className="rows-label">关于</li>
        {LEGAL_ROWS.map(([doc, preview]) => (
          <SettingsRow key={doc} name={LEGAL_LINK_NAMES[doc]} note={preview} href={LEGAL_PATHS[doc]} />
        ))}
      </ul>
    </>
  );
}

function BackButton() {
  const up = useUp();
  return (
    <button type="button" className="back only-mobile" onClick={up}>
      <ChevronLeft size={20} aria-hidden="true" /> 返回
    </button>
  );
}

function NameForm({ account }) {
  const { dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [name, setName] = useState(account.displayName);
  const [error, setError] = useState("");
  useEffect(() => setName(account.displayName), [account.displayName]);
  const unchanged = name.trim() === account.displayName;

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null || unchanged) return;
    const problem = displayNameProblem(name);
    setError(problem);
    if (problem) return;
    const res = await run("name", () => actions.updateDisplayName(name.trim()), (e) => profileErrorText("name", e));
    if (res.ok) dispatch({ type: "toast", text: "昵称已更新" });
  };

  return (
    <form onSubmit={submit}>
      <Field label="昵称" error={error} hint="1–40 个字，只能一行。其他人会在下次同步时看到新昵称。">
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Btn type="submit" variant="primary" disabled={busy !== null || unchanged}>
        {busy === "name" ? "保存中…" : "保存"}
      </Btn>
    </form>
  );
}

/**
 * My account name (账号名), changed once a year (`PATCH /api/me {handle}`, Task N): my Agents' full handles follow it. When it
 * may change again is read from `GET /api/me` when the page opens and after a change (`loadHandleChange`); while the
 * service says a date the box is locked and the date is shown. Unread or unreadable: no date, and the service decides.
 * Refusals (`这个名字已经有人用了`, the year not up) are shown under the box, never toasted.
 */
function HandleForm({ account }) {
  const { dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [handle, setHandle] = useState(account.handle);
  const [error, setError] = useState("");
  const [availableAt, setAvailableAt] = useState(null);
  useEffect(() => setHandle(account.handle), [account.handle]);
  useEffect(() => {
    let live = true;
    actions.loadHandleChange().then((res) => {
      if (live && res.ok) setAvailableAt(res.value);
    });
    return () => {
      live = false;
    };
  }, [actions]);
  const day = availableAt === null ? null : dayText(availableAt);
  const waiting = day !== null;
  const unchanged = handle === account.handle;

  const submit = async (event) => {
    event.preventDefault();
    if (busy !== null || unchanged || waiting) return;
    const problem = handleProblem(handle);
    setError(problem);
    if (problem) return;
    const res = await run("handle", () => settled(actions.changeHandle(handle)), () => "");
    if (!res.ok) {
      if (res.error?.code === "busy_here") return;
      setError(refusalText(res.error));
      // Too soon: the date the service says locks the box, as a read of it would.
      if (res.error?.error?.code === "handle_change_too_soon" && dayText(res.error.error.availableAt)) setAvailableAt(res.error.error.availableAt);
      return;
    }
    dispatch({ type: "toast", text: "账号名已更新" });
    const next = await actions.loadHandleChange();
    if (next.ok) setAvailableAt(next.value);
  };

  return (
    <form onSubmit={submit}>
      <Field label="账号名" error={error} hint={waiting ? `一年可以改一次，${day}起可以再改` : "3 到 24 位小写字母、数字或下划线。一年可以改一次。"}>
        <input
          value={handle}
          disabled={waiting}
          onChange={(e) => {
            setHandle(e.target.value);
            setError("");
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <Btn type="submit" variant="primary" disabled={busy !== null || unchanged || waiting}>
        {busy === "handle" ? "保存中…" : "修改账号名"}
      </Btn>
    </form>
  );
}

function ProfilePage() {
  const { state, dispatch, actions } = useStore();
  const signOut = useSignOut();
  // (Before the first load there is no account yet: the page shows what the people table knows.)
  const self = entity(state, ME);
  const account = state.account ?? { displayName: self?.displayName ?? "", handle: String(self?.handle ?? "").replace(/^@/, ""), email: "" };
  return (
    <section className="page" aria-label="设置">
      <BackButton />
      <header className="profile-head">
        <div>
          <h2>我的资料</h2>
          <p className="muted">{account.displayName} <Tag tone="human">真人</Tag> @{account.handle}</p>
        </div>
      </header>
      <div className="page-body">
        <h3>头像</h3>
        <AvatarEditor upload={actions.uploadAvatar} errorText={(e) => profileErrorText("avatar", e)} />
        <NameForm account={account} />
        <HandleForm account={account} />
        <h3>账户</h3>
        <KV rows={[["邮箱", account.email ?? ""]]} />
        <p className="muted">邮箱不能修改。</p>
        {signOut && (
          <div className="stack-actions row-actions">
            <Btn variant="danger" onClick={signOut}>退出登录</Btn>
          </div>
        )}
      </div>
    </section>
  );
}

/** The people I blocked, each with a way to lift it (confirmed first, as everywhere). */
function BlockedPage() {
  const { state } = useStore();
  const [target, setTarget] = useState(null);
  const mine = state.blocks.filter((b) => b.by === ME);
  return (
    <section className="page" aria-label="拉黑">
      <BackButton />
      <header className="profile-head">
        <div>

          <h2>拉黑</h2>
          <p className="muted">拉黑后，你们之间不能发送新消息，也不能互相申请好友；只有你可以解除自己的拉黑。</p>
        </div>
      </header>
      <div className="page-body">
        {mine.length === 0 ? (
          <p className="muted">你没有拉黑任何人。</p>
        ) : (
          <ul className="member-rows" aria-label="我拉黑的人和 Agent">
            {mine.map((b) => (
              <li key={b.target}>
                <Avatar id={b.target} size={40} />
                <div className="member-body">
                  <strong>
                    {nameOf(state, b.target)}
                    {state.agents[b.target] && <> <Tag>Agent</Tag></>}
                  </strong>
                  <p className="muted">{entity(state, b.target)?.handle ?? ""}</p>
                </div>
                <div className="member-actions">
                  <Btn small onClick={() => setTarget(b.target)}>解除拉黑</Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {target && <BlockModal target={target} onClose={() => setTarget(null)} />}
    </section>
  );
}

const NEW_NOTES = [
  ["auto", "自动判断要不要进保险箱"],
  ["vault", "全部进保险箱"],
  ["open", "全部不进保险箱"],
];

/**
 * My memory settings, read once (`GET /api/me`): 作息 (the switch 入梦 and 记忆用的语言, with the question about converting the notes
 * already there), 新记下的内容 (where a note goes when it is written, the vault or not) and
 * 用哪个模型整理记忆 (the model that tidies it). Each box shows what the service holds; a change is shown once it is saved,
 * a refusal is toasted and the box stays as it was. `settings`: null while being read, "" when it could not be (every control
 * stay off and say so).
 */
/** What the conversion's refusals say (`POST /api/memory/language/convert`); any other refusal is said as everywhere else. */
const CONVERT_REFUSED = {
  no_language: "先选一种语言。",
  busy: "正在整理记忆，稍等一会儿再试。",
  unavailable: "现在转不了，稍后再试。",
};
const convertRefusalText = (error) => CONVERT_REFUSED[error?.error?.code] ?? refusalText(error);

/** How often a conversion under way is asked how it stands. */
const CONVERT_POLL_MS = 3000;
/** A conversion the service no longer knows of (it restarted while it ran). */
const LOST = "lost";

/** How a conversion went: what was converted and kept, and — only when there is something — what it could not do. */
function convertedLine(result) {
  if (result === LOST) return "转换可能还在进行，稍后在这里看结果。";
  return [
    `转了 ${result.converted} 条，${result.kept} 条保持原样。`,
    result.noRoom > 0 ? `有 ${result.noRoom} 条因为房间装不下没有转，可以先整理再试。` : "",
    result.failedRooms > 0 ? `有 ${result.failedRooms} 个房间这次没转成，稍后可以再试。` : "",
  ]
    .filter(Boolean)
    .join("");
}

/** The first row of 用哪个模型整理记忆: the site's calibrated model (stored as no choice, null). */
const CALIBRATED = { key: "", name: "站点的模型（已校准）", terms: ["站点的模型（已校准）"] };
/** Why a paid site model cannot tidy memory (the service refuses it). */
const PAID_FOR_MEMORY = "记忆由站点出钱，只能用免费模型";

function MemorySettings() {
  const { dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const sources = useModelSources();
  const pickId = useId();
  const [settings, setSettings] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // The language just chosen, while I am asked whether to convert the notes already there; and how the conversion went.
  const [asked, setAsked] = useState(null);
  const [converted, setConverted] = useState(null);
  useEffect(() => {
    let alive = true;
    actions.loadMemorySettings().then((res) => {
      if (alive) setSettings(res.ok ? res.value : "");
    });
    return () => {
      alive = false;
    };
  }, [actions, attempt]);
  const retry = () => {
    setSettings(null);
    setAttempt((n) => n + 1);
  };
  const off = !settings || busy !== null;
  /** What a box says before the settings are read (or when they could not be). */
  const unread = settings === null ? "正在读取…" : "读取失败";

  const changeDream = async (event) => {
    const res = await run("dream", () => settled(actions.setDream(event.target.checked)), refusalText);
    if (res.ok) setSettings((cur) => ({ ...cur, dream: res.value }));
  };

  const changeLanguage = async (value) => {
    const next = value === "auto" ? null : value;
    const res = await run("memoryLanguage", () => settled(actions.setMemoryLanguage(next)), refusalText);
    if (!res.ok) return;
    setSettings((cur) => ({ ...cur, memoryLanguage: res.value }));
    setConverted(null);
    setAsked(res.value);
  };

  // The conversion runs on the service by itself: started, then asked how it stands every `CONVERT_POLL_MS` until it is done (never once
  // this page is gone). Not knowing it any more (`idle`: the service restarted meanwhile) is said as such.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const followConversion = async () => {
    await settled(actions.convertMemoryLanguage());
    for (;;) {
      await new Promise((wake) => setTimeout(wake, CONVERT_POLL_MS));
      if (!mounted.current) return null;
      const now = await actions.loadMemoryConversion();
      if (!mounted.current) return null;
      if (!now.ok || now.value.state === "running") continue;
      if (now.value.state === "idle") return LOST;
      // Nothing could be done at all: refused as a request that could not start is.
      if (now.value.unavailable) throw { error: { code: "unavailable" } };
      return now.value.result;
    }
  };
  const convertNotes = async () => {
    const res = await run("convert", followConversion, convertRefusalText);
    if (!res.ok || res.value === null) return;
    setConverted(res.value);
    setAsked(null);
  };

  const changeNewNotes = async (value) => {
    const res = await run("newNotes", () => settled(actions.setNewNotes(value)), refusalText);
    if (res.ok) setSettings((cur) => ({ ...cur, newNotes: res.value }));
  };

  // Memory the site pays for runs only on its free models: a paid site model is shown, but cannot be chosen, and says why. The chosen
  // model leads the list when it is no longer offered, as it does on the Agent form, after the site's calibrated model (no choice: null).
  const site = sources.choices.site.map((c) => (c.paid ? { ...c, usable: false, reason: PAID_FOR_MEMORY } : c));
  const memorySources = { ...sources, choices: { ...sources.choices, site } };
  const options = settings ? choiceList(memorySources, settings.memoryModel) : [];
  const lead = [CALIBRATED, ...staleRows(options)];
  const groups = pickerGroups(memorySources);
  const modelValue = settings ? modelKey(settings.memoryModel) : null;
  const shownModel = [...lead, ...groups.flatMap((g) => g.options)].find((o) => o.key === modelValue) ?? null;
  const changeModel = async (key) => {
    const next = options.find((o) => o.key === key)?.model ?? null;
    const res = await run("memoryModel", () => settled(actions.setMemoryModel(next)), refusalText);
    if (!res.ok) return;
    // Whether it can be used is the service's to say (its key may be unset or unreadable): read the settings again; when
    // that fails, what was saved is shown and the warning waits for the next read.
    const again = await actions.loadMemorySettings();
    setSettings((cur) => (again.ok ? again.value : { ...cur, memoryModel: res.value }));
  };
  return (
    <>
      <section aria-label="作息">
        <h3>作息</h3>
        <p>
          <strong>小憩</strong> <Tag tone="muted">一直开着</Tag>
        </p>
        <p className="field-hint">聊完一段后，它会回想刚才的对话，记下值得留的事。</p>
        <fieldset className="memory-switches" disabled={off}>
          <Switch
            checked={settings?.dream === true}
            onChange={changeDream}
            label="入梦"
            hint="你休息的时候，它把这一天记下的整理一遍：合并重复的，分清一时的情绪和长久的事。"
            hintClass="field-hint"
          />
        </fieldset>
        <Field label="记忆用的语言" hint="它记下的笔记统一用这种语言写；名字和原话保留原文。">
          <Select
            value={settings ? (settings.memoryLanguage ?? "auto") : null}
            placeholder={unread}
            disabled={off}
            onChange={changeLanguage}
            listLabel="记忆用的语言"
            options={[{ value: "auto", label: "自动" }, ...MEMORY_LANGUAGES.map(([code, name]) => ({ value: code, label: name }))]}
          />
        </Field>
        {busy === "convert" ? (
          <p className="field-hint" role="status">正在转换…</p>
        ) : converted ? (
          <p className="field-hint" role="status">{convertedLine(converted)}</p>
        ) : asked ? (
          <p className="field-hint">
            <span>把已有的笔记也转成{languageName(asked)}吗？</span>{" "}
            <Btn small disabled={off} onClick={convertNotes}>转换</Btn> <Btn small disabled={off} onClick={() => setAsked(null)}>先不用</Btn>
          </p>
        ) : null}
      </section>
      <Field label="新记下的内容" hint="只管以后新记下的；已经记下的不会因此移动。">
        <Select
          value={settings?.newNotes ?? null}
          placeholder={unread}
          disabled={off}
          onChange={changeNewNotes}
          listLabel="新记下的内容"
          options={NEW_NOTES.map(([id, label]) => ({ value: id, label }))}
        />
      </Field>
      <div className="field">
        <label id={`${pickId}-label`} htmlFor={pickId}>用哪个模型整理记忆</label>
        <ModelSelect
          id={pickId}
          labelledBy={`${pickId}-label`}
          describedBy={`${pickId}-hint`}
          value={modelValue}
          current={shownModel && { name: shownModel.name, brand: shownModel.brand }}
          placeholder={unread}
          lead={lead}
          groups={groups}
          disabled={off || sources.status !== "ready"}
          footer={<Btn small variant="text" onClick={() => dispatch({ type: "nav", patch: PROVIDERS_PAGE })}>管理供应商</Btn>}
          onChange={changeModel}
        />
        <p id={`${pickId}-hint`} className="field-hint">换成自己的模型后，记得好不好我们没法保证；安全检查不变。</p>
      </div>
      {settings && !settings.memoryModelUsable && <Reason>选的模型现在用不了，记忆暂时不会更新。</Reason>}
      {settings === "" && (
        <Reason>
          没能读取这项设置，请重试。 <Btn small onClick={retry}>重试</Btn>
        </Reason>
      )}
    </>
  );
}

/** 记忆宫殿: how new notes are sorted, and the room 关于我 (shared by all my Agents). */
function MemoryPage() {
  const memory = useMemoryRoom(null);
  const { room, failure } = memory;
  return (
    <section className="page" aria-label="记忆宫殿">
      <BackButton />
      <header className="profile-head">
        <div>
          <h2>记忆宫殿</h2>
          <p className="muted">Agent 记住的事都在这里，可以随时整理。</p>
        </div>
      </header>
      <div className="page-body">
        <MemorySettings />
        {room ? (
          <MemoryRoom title="关于我" helper="你名下的所有 Agent 共用这一份。" memory={memory} />
        ) : failure ? (
          <p className="field-msg" role="alert">{failure}</p>
        ) : (
          <p className="muted">正在读取…</p>
        )}
      </div>
    </section>
  );
}

/** The settings page `nav.settingsPage` names: "profile" (the default), "providers", "usage", "others", "memory" or "blocks". */
export function SettingsMain() {
  const { state } = useStore();
  switch (state.nav.settingsPage) {
    case "blocks":
      return <BlockedPage />;
    case "providers":
      return <ProvidersPage back={<BackButton />} />;
    case "usage":
      return <UsagePage back={<BackButton />} />;
    case "others":
      return <OthersUsePage back={<BackButton />} />;
    case "memory":
      return <MemoryPage />;
    default:
      return <ProfilePage />;
  }
}
