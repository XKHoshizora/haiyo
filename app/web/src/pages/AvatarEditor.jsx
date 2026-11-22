import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { Avatar, Btn } from "../ui/primitives.jsx";
import { PICK_TYPES, pickProblem } from "../ui/avatarCrop.js";
import { AvatarDialog } from "./AvatarDialog.jsx";
import { useAction } from "./useAction.js";

/**
 * Pick a picture, adjust it in the 调整头像 dialog (`AvatarDialog`), and use what the dialog saves: a 512 × 512 crop, never
 * the file that was picked.
 * - With `upload(file)` (a promise that rejects on a refusal): the dialog's 保存 sends it at once; `errorText(error)` is
 *   shown in the dialog when it fails (the dialog stays), `doneText` toasted when it worked. My own avatar, an existing
 *   Agent's, a group's.
 * - With `onPick(file | null)` instead: the saved crop is only held (and shown), for the page to send later (an Agent's,
 *   once it exists). `disabled` while the page is busy.
 * - `onRemove()` (a promise): adds a 移除 button that takes the avatar away (a group's); `canRemove` false hides it while
 *   there is none.
 * `id`: whose avatar shows while nothing is held (null: the blank one of an Agent not created yet); `current` shows
 * something else instead (a group's). `hint` replaces the line under it.
 */
export function AvatarEditor({
  id = ME,
  current,
  upload,
  errorText,
  doneText = "头像已更新",
  onPick,
  disabled = false,
  hint,
  onRemove,
  canRemove = true,
  removedText = "头像已移除",
  removeErrorText,
}) {
  const { dispatch } = useStore();
  const { busy, run } = useAction();
  const [picked, setPicked] = useState(null); // the file in the dialog
  const [held, setHeld] = useState(null); // {file, url}: the saved crop of a form that sends it later
  const [error, setError] = useState("");
  const urlRef = useRef(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const browseRef = useRef(null);
  const [refocus, setRefocus] = useState(false);
  const holding = typeof onPick === "function";

  const discard = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setHeld(null);
  };
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // Focus goes to the first button only when it is enabled again (it is disabled while the removal was busy).
  useEffect(() => {
    if (refocus && busy === null) {
      browseRef.current?.focus();
      setRefocus(false);
    }
  }, [refocus, busy]);

  // The dialog is in the body, so it would outlive this page when the layout stops drawing it (a wide window narrowed to one column while
  // the dialog of the page beside the list was open): it closes with the page.
  const open = picked !== null && busy === null;
  useEffect(() => {
    if (!open) return undefined;
    const lost = () => {
      if (rootRef.current && rootRef.current.getClientRects().length === 0) setPicked(null);
    };
    window.addEventListener("resize", lost);
    return () => window.removeEventListener("resize", lost);
  }, [open]);

  const choose = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const problem = pickProblem(file);
    setError(problem);
    if (!problem) setPicked(file);
  };

  /** What the dialog's 保存 does with the crop: "" when taken, else the sentence to show in the dialog. */
  const take = async (cropped) => {
    if (holding) {
      discard();
      urlRef.current = URL.createObjectURL(cropped);
      setHeld({ file: cropped, url: urlRef.current });
      onPick(cropped);
      setPicked(null);
      return "";
    }
    const res = await run("avatar", () => upload(cropped), () => "");
    if (!res.ok) return errorText ? errorText(res.error) : "头像没有保存成功，请再试一次。";
    setPicked(null);
    setError("");
    dispatch({ type: "toast", text: doneText });
    return "";
  };

  const drop = () => {
    discard();
    onPick(null);
  };
  const remove = async () => {
    const res = await run("remove", onRemove, removeErrorText ?? (() => "没有移除成功，请再试一次。"));
    if (res.ok) {
      dispatch({ type: "toast", text: removedText });
      setRefocus(true); // the button that was pressed is gone: the first one takes the focus once nothing is busy
    }
  };
  const browse = () => inputRef.current?.click();

  // The first button is one element in every state (its label changes), so the dialog's focus return always finds it.
  const buttons = (
    <>
      <Btn ref={browseRef} disabled={holding ? disabled : busy !== null} onClick={browse}>
        {holding ? (held ? "换一张" : "选择头像") : "更换头像"}
      </Btn>
      {/* Not "取消": the form around it has its own. */}
      {holding && held && <Btn disabled={disabled} onClick={drop}>不用这张</Btn>}
      {!holding && onRemove && canRemove && <Btn disabled={busy !== null} onClick={remove}>{busy === "remove" ? "移除中…" : "移除头像"}</Btn>}
    </>
  );

  const limits = "支持 PNG、JPEG、WebP，不超过 20 MB；选好后可以拖动和缩放。";
  return (
    <div className="avatar-editor" ref={rootRef}>
      {held ? (
        <span className="avatar avatar-preview" style={{ width: 84, height: 84 }}>
          <span className="avatar-img avatar-fallback" style={{ width: 84, height: 84 }}>
            <img src={held.url} alt="新头像预览" />
          </span>
        </span>
      ) : (
        current ?? <Avatar id={id} size={84} />
      )}
      <div className="stack-actions row-actions">
        <input ref={inputRef} type="file" accept={PICK_TYPES.join(",")} hidden aria-label="选择头像图片" onChange={choose} />
        {buttons}
      </div>
      <p className={error ? "field-msg" : "field-hint"} role={error ? "alert" : undefined}>
        {error || hint || (holding ? `${limits}不选择则使用默认头像。` : limits)}
      </p>
      {/* In the body, not inside a form around this (Enter on the slider would submit it). */}
      {picked && createPortal(<AvatarDialog key={picked.name + picked.size + picked.lastModified} file={picked} onCancel={() => setPicked(null)} onSave={take} />, document.body)}
    </div>
  );
}
