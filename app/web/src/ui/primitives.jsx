import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Info, CircleAlert, CircleCheck, CirclePause, Users, Bot } from "../icons.js";
import { PRODUCT_NAME } from "../brand.js";
import { useStore } from "../data/store.jsx";
import { avatarUrl } from "../api/routes.js";
import { entity, isAgent, nameOf, ownerOf, otherMember } from "../state/selectors.js";
import { ME } from "../data/identities.js";
import { useLayer } from "./layers.js";

export const asset = (path) => `${import.meta.env.BASE_URL}${String(path).replace(/^\//, "")}`;

/** The picture of a person from the service; the initial on the colour shows while it loads and when it fails. */
function AvatarImage({ src }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

export function Avatar({ id, size = 44, online = false, className = "" }) {
  const { state } = useStore();
  const who = entity(state, id);
  // Anyone has an avatar at the service (a generated one when none was uploaded), also a member who left;
  // only "me" before the first load is not known yet. Every URL carries the avatar's version, so a change shows at once.
  const src = who?.avatar ?? (id && id !== ME ? avatarUrl(id, state.avatarVersions?.[id] ?? 0) : null);
  const initial = [...String(who?.displayName ?? who?.name ?? "")][0] ?? "";
  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size }} role="img" aria-label={who?.name || "头像"}>
      <span className="avatar-img avatar-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
        {initial}
        {src && <AvatarImage key={src} src={src} />}
      </span>
      {online && <span className="avatar-dot" />}
    </span>
  );
}

export function BrandMark({ size = 36 }) {
  return <img className="brand-mark" src={asset("assets/agent-family-mark-v2.png")} width={size} height={size} alt={PRODUCT_NAME} />;
}

// Composite of 2–4 speaking members. Never substitutes an owner's face for an Agent.
export function GroupAvatar({ ids, size = 46 }) {
  const list = ids.slice(0, 4);
  const small = Math.round(size * (list.length <= 2 ? 0.62 : 0.54));
  return (
    <span className={`group-avatar n${list.length}`} style={{ width: size, height: size }} role="img" aria-label="群头像">
      {list.map((id) => (
        <Avatar key={id} id={id} size={small} />
      ))}
    </span>
  );
}

/** A group's own picture; when it cannot be shown (not loaded, gone), the composite of its members stands in. */
function GroupPicture({ src, ids, size }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <GroupAvatar ids={ids} size={size} />;
  return (
    <span className="avatar group-picture" style={{ width: size, height: size }} role="img" aria-label="群头像">
      <span className="avatar-img avatar-fallback" style={{ width: size, height: size }}>
        <img key={src} src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      </span>
    </span>
  );
}

export function ConvAvatar({ conv, size = 46 }) {
  if (conv.type === "human" || conv.type === "agent") return <Avatar id={otherMember(conv)} size={size} />;
  return conv.avatar ? <GroupPicture key={conv.avatar} src={conv.avatar} ids={conv.members} size={size} /> : <GroupAvatar ids={conv.members} size={size} />;
}

export function Tag({ tone = "agent", children }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

/**
 * A group's header line: its people and, when it has any, its Agents, each a small icon and a number (the icons of the sidebar: Users, Bot) with a thin divider
 * between: the real numbers (a group has at most 500 members; three digits fit at 360 px). Each count has its own accessible name and a title (「3 人」「1 个 Agent」); no Agent, no second count (never "0"). One line, never wrapped.
 */
export function HeadCounts({ people, agents }) {
  const count = (label, Icon, n) => (
    <span className="head-count" role="img" aria-label={label} title={label}>
      <Icon size={14} aria-hidden="true" />
      <span aria-hidden="true">{n}</span>
    </span>
  );
  return (
    <span className="head-counts">
      {count(`${people} 人`, Users, people)}
      {agents > 0 && (
        <>
          <span className="head-counts-sep" aria-hidden="true" />
          {count(`${agents} 个 Agent`, Bot, agents)}
        </>
      )}
    </span>
  );
}

export function IdentityLine({ id, showOwner = true, extra }) {
  const { state } = useStore();
  const agent = isAgent(state, id);
  return (
    <span className="identity-line">
      <strong>{nameOf(state, id)}</strong>
      {agent && <Tag>Agent</Tag>}
      {agent && showOwner && <span className="owner">主人：{nameOf(state, ownerOf(state, id))}</span>}
      {extra}
    </span>
  );
}

const NOTICE_ICON = { info: Info, warn: CircleAlert, ok: CircleCheck, pause: CirclePause };
export function Notice({ tone = "info", children, action }) {
  const Icon = NOTICE_ICON[tone] || Info;
  return (
    <div className={`notice notice-${tone}`} role={tone === "warn" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function Btn({ variant = "ghost", small, reason, className = "", children, ref, ...rest }) {
  return (
    <button ref={ref} type="button" className={`btn btn-${variant} ${small ? "btn-sm" : ""} ${className}`} title={rest.disabled ? reason : undefined} {...rest}>
      {children}
    </button>
  );
}

/** The one style of a plain text link (navigation): accent colour, underlined on hover and keyboard focus (styles.css `.text-link`). An action is a button (`Btn`, or `btn` on an anchor), not this. */
export function TextLink({ className = "", children, ...rest }) {
  return (
    <a className={`text-link ${className}`.trim()} {...rest}>
      {children}
    </a>
  );
}

export function IconBtn({ label, children, className = "", ...rest }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Reason({ children }) {
  if (!children) return null;
  return (
    <p className="reason">
      <Info size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A dialog: a modal layer (ui/layers.js) drawn over everything, in document.body — the page behind inert, the focus in it and back
 * to its opener (`returnTo()` when the opener went away, as a menu's item does), Esc, Back and the backdrop close it through
 * `onClose`; `locked` while it may not be left (a save under way).
 */
export function Modal({ title, onClose, children, footer, wide, returnTo = null, locked = false }) {
  const backdrop = useRef(null);
  const anchor = useRef(null);
  const titleId = useId();
  useLayer(backdrop, { onClose, returnTo, held: () => locked });
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    // A dialog does not outlive the page it belongs to: when the layout no longer draws that page (a wide window narrowed to one
    // column while a dialog of the page beside the list was open), it is not left mounted and unseen. (Its place in the page is the anchor.)
    const lost = () => {
      const place = anchor.current?.parentElement;
      if (place && place.getClientRects().length === 0) closing.current?.();
    };
    window.addEventListener("resize", lost);
    return () => window.removeEventListener("resize", lost);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div className="modal-backdrop" ref={backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <header className="modal-head">
              <h2 id={titleId}>{title}</h2>
              <IconBtn label="关闭" onClick={onClose}>
                <X size={18} />
              </IconBtn>
            </header>
            <div className="modal-body">{children}</div>
            {footer && <footer className="modal-foot">{footer}</footer>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * The line of a list that is not loaded yet: loading until the first sync has answered; once the connection has failed (it retries by itself,
 * with a back-off), the failure and a retry, never 「正在读取…」 for ever.
 */
export function LoadingRow() {
  const { state, actions } = useStore();
  const failing = state.connectionFailed === true;
  return (
    <li className="rows-empty" role="status">
      {failing ? (
        <>
          连不上服务，正在重试… <Btn small onClick={() => actions.retryNow()}>立即重试</Btn>
        </>
      ) : (
        "正在读取…"
      )}
    </li>
  );
}

export function Field({ label, hint, error, children }) {
  const id = useId();
  return (
    <div className={`field ${error ? "field-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? `${id}-help` : undefined })}
      {error ? <p id={`${id}-help`} className="field-msg" role="alert">{error}</p> : hint ? <p id={`${id}-help`} className="field-hint">{hint}</p> : null}
    </div>
  );
}

/** A labelled on/off switch with a line saying what it does (`hintClass` styles that line). */
export function Switch({ checked, onChange, label, hint, hintClass }) {
  const hintId = useId();
  return (
    <>
      <label className="check">
        <input type="checkbox" role="switch" checked={checked} aria-describedby={hintId} onChange={onChange} />
        {label}
      </label>
      <p id={hintId} className={hintClass}>{hint}</p>
    </>
  );
}

export function focusInvalid(container) {
  requestAnimationFrame(() => {
    const field = (container || document.querySelector('.modal') || document).querySelector('[aria-invalid="true"]');
    field?.focus({ preventScroll: true });
    field?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
