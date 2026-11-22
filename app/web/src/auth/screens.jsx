import React, { useEffect, useId, useRef, useState } from "react";
import { PRODUCT_NAME } from "../brand.js";
import { BrandMark, Btn, Field, Notice, TextLink, focusInvalid } from "../ui/primitives.jsx";
import { fieldOf, messageFor, verifyMessage } from "./errors.js";
import { clearResetToken, navigate, takeResetToken, takeReturn } from "./router.js";
import * as rules from "./validation.js";

function Link({ to, children, primary = false }) {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  // The one prominent link of a page is a button; the others are the shared text link.
  return primary ? (
    <a className="btn btn-primary" href={to} onClick={onClick}>
      {children}
    </a>
  ) : (
    <TextLink href={to} onClick={onClick}>
      {children}
    </TextLink>
  );
}

function AuthCard({ title, lead, children, footer }) {
  const titleId = useId();
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby={titleId}>
        <header className="auth-head">
          <BrandMark size={44} />
          <h1 id={titleId}>{title}</h1>
          {lead && <p className="muted">{lead}</p>}
        </header>
        {children}
        {footer && <footer className="auth-foot">{footer}</footer>}
      </section>
    </main>
  );
}

/**
 * Values, inline errors, a busy flag and a form-level error. `submit(values)` runs once the rules pass;
 * a thrown ApiError is shown on its field (focused) or on the form. Nothing the user typed is ever logged.
 */
function useAuthForm({ initial, rules: fieldRules, submit, noMail = false }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const formRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Focus the first invalid field once the errors it depends on are on screen.
  useEffect(() => {
    if (focusRequest) focusInvalid(formRef.current);
  }, [focusRequest]);

  const bind = (name) => ({
    name,
    value: values[name],
    onChange: (e) => {
      const value = e.target.value;
      setValues((v) => ({ ...v, [name]: value }));
      setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
    },
  });

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const found = rules.validate(values, fieldRules);
    setFormError(null);
    setErrors(found);
    if (Object.keys(found).length) {
      setFocusRequest((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      await submit(values);
    } catch (err) {
      if (!alive.current) return;
      const code = err?.code;
      const field = fieldOf(code);
      if (field && field in values) {
        setErrors({ [field]: messageFor(code, noMail) });
        setFocusRequest((n) => n + 1);
      } else {
        setFormError(messageFor(code, noMail));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return { values, errors, formError, busy, bind, onSubmit, formRef };
}

/**
 * What the pages that would say "we sent you a mail" say on a site that sends none (`GET /api/site`): after registering the
 * administrator gives a verification link, after a reset request a reset link.
 */
export const NO_MAIL = { verify: "这个站点不发送邮件。请向管理员索取验证链接。", reset: "这个站点不发送邮件。请向管理员索取重置链接。" };

/**
 * Whether this site really sends mail (`GET /api/site`, asked once per page): false on a site that only keeps mail in its
 * outbox; null while not known, or when it could not be asked (the page then says what it always said).
 */
function useMailDelivered(api) {
  const [delivered, setDelivered] = useState(null);
  useEffect(() => {
    let alive = true;
    if (typeof api?.getSite !== "function") return undefined;
    api.getSite().then(
      (site) => alive && typeof site?.mailDelivered === "boolean" && setDelivered(site.mailDelivered),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return delivered;
}

function FormBody({ form, submitLabel, children }) {
  return (
    <form className="auth-form" onSubmit={form.onSubmit} ref={form.formRef} noValidate>
      {form.formError && <Notice tone="warn">{form.formError}</Notice>}
      {children}
      <Btn type="submit" variant="primary" className="auth-submit" disabled={form.busy}>
        {form.busy ? "请稍候…" : submitLabel}
      </Btn>
    </form>
  );
}

export function SignIn({ api, onSignedIn, expired }) {
  const mailDelivered = useMailDelivered(api);
  const form = useAuthForm({
    noMail: mailDelivered === false,
    initial: { email: "", password: "" },
    rules: { email: rules.email, password: rules.currentPassword },
    submit: async ({ email, password }) => {
      // callbackURL: where the verification mail resent after a correct password lands.
      await api.signIn({ email: email.trim(), password, callbackURL: "/verify" });
      const me = await api.getMe();
      onSignedIn(me);
      navigate(takeReturn() ?? "/", { replace: true }); // (a page of the app that was asked for signed out comes first)
    },
  });
  return (
    <AuthCard
      title={`登录 ${PRODUCT_NAME}`}
      footer={
        <>
          <Link to="/forgot">忘记密码</Link>
          <Link to="/register">注册新账号</Link>
        </>
      }
    >
      {expired && <Notice tone="pause">登录已失效，请重新登录。</Notice>}
      <FormBody form={form} submitLabel="登录">
        <Field label="邮箱" error={form.errors.email}>
          <input type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} {...form.bind("email")} />
        </Field>
        <Field label="密码" error={form.errors.password}>
          <input type="password" autoComplete="current-password" {...form.bind("password")} />
        </Field>
      </FormBody>
    </AuthCard>
  );
}

export function Register({ api }) {
  const [sentTo, setSentTo] = useState(null);
  const mailDelivered = useMailDelivered(api);
  const form = useAuthForm({
    initial: { inviteCode: "", email: "", password: "", displayName: "", handle: "" },
    rules: { inviteCode: rules.inviteCode, email: rules.email, password: rules.newPassword, displayName: rules.displayName, handle: rules.handle },
    submit: async (v) => {
      await api.register({ inviteCode: v.inviteCode.trim(), email: v.email.trim(), password: v.password, displayName: v.displayName.trim(), handle: v.handle });
      setSentTo(v.email.trim());
    },
  });

  if (sentTo && mailDelivered === false) {
    // The same page whether or not the address had an account (the service's answer is the same).
    return (
      <AuthCard title="验证邮箱" footer={<Link to="/signin">去登录</Link>}>
        <Notice>{NO_MAIL.verify}</Notice>
      </AuthCard>
    );
  }
  if (sentTo) {
    return (
      <AuthCard title="请查收邮箱" footer={<Link to="/signin">去登录</Link>}>
        <Notice tone="ok">我们已向 {sentTo} 发送了一封验证邮件。点击邮件里的链接完成验证，之后就可以登录了。</Notice>
        <p className="muted">没收到？看看垃圾邮件箱；还没验证时用注册的邮箱和密码登录，我们会再发一封。</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="注册账号" lead="需要邀请码才能注册。" footer={<Link to="/signin">已有账号？去登录</Link>}>
      <FormBody form={form} submitLabel="注册">
        <Field label="邀请码" error={form.errors.inviteCode}>
          <input type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} {...form.bind("inviteCode")} />
        </Field>
        <Field label="邮箱" error={form.errors.email}>
          <input type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} {...form.bind("email")} />
        </Field>
        <Field label="密码" hint="至少 10 位" error={form.errors.password}>
          <input type="password" autoComplete="new-password" {...form.bind("password")} />
        </Field>
        <Field label="昵称" hint="别人看到的名字，最多 40 个字" error={form.errors.displayName}>
          <input type="text" autoComplete="nickname" {...form.bind("displayName")} />
        </Field>
        <Field label="账号名" hint="3 到 24 位小写字母、数字或下划线，别人用它找到你" error={form.errors.handle}>
          <input type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} {...form.bind("handle")} />
        </Field>
      </FormBody>
      <p className="muted">已经注册过？直接登录就行。</p>
    </AuthCard>
  );
}

/** Where the verification link ends. `error` is Better Auth's code from the redirect, or empty for success. */
export function Verify({ api, error, signedIn }) {
  const [code] = useState(error ?? null);
  const mailDelivered = useMailDelivered(api);
  useEffect(() => {
    navigate("/verify", { replace: true }); // the address keeps no query
  }, []);
  const next = signedIn ? <Link to="/" primary={!code}>进入应用</Link> : <Link to="/signin" primary={!code}>去登录</Link>;
  return (
    <AuthCard title={code ? "邮箱没有验证成功" : "邮箱已验证"} footer={next}>
      {code ? <Notice tone="warn">{verifyMessage(code, mailDelivered === false)}</Notice> : <Notice tone="ok">邮箱已验证，现在可以登录了。</Notice>}
    </AuthCard>
  );
}

export function Forgot({ api }) {
  const [sent, setSent] = useState(false);
  const mailDelivered = useMailDelivered(api);
  const form = useAuthForm({
    initial: { email: "" },
    rules: { email: rules.email },
    submit: async ({ email }) => {
      await api.requestPasswordReset({ email: email.trim() });
      setSent(true);
    },
  });
  if (sent && mailDelivered === false) {
    return (
      <AuthCard title="重置密码" footer={<Link to="/signin">回到登录</Link>}>
        <Notice>{NO_MAIL.reset}</Notice>
      </AuthCard>
    );
  }
  if (sent) {
    return (
      <AuthCard title="请查收邮箱" footer={<Link to="/signin">回到登录</Link>}>
        <Notice tone="ok">如果这个邮箱已注册，我们会发送一封重置密码的邮件。链接 1 小时内有效。</Notice>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="忘记密码"
      lead={mailDelivered === false ? "输入注册时用的邮箱。这个站点不发送邮件，提交后请向管理员索取重置链接。" : "输入注册时用的邮箱，我们会发一封重置密码的邮件。"}
      footer={<Link to="/signin">回到登录</Link>}
    >
      <FormBody form={form} submitLabel="发送重置邮件">
        <Field label="邮箱" error={form.errors.email}>
          <input type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} {...form.bind("email")} />
        </Field>
      </FormBody>
    </AuthCard>
  );
}

/** The token was taken from the address (captureResetToken) before this renders; it lives only in this state. */
export function ResetPassword({ api }) {
  const [token] = useState(takeResetToken);
  const [done, setDone] = useState(false);
  useEffect(() => clearResetToken, []);
  const form = useAuthForm({
    initial: { password: "" },
    rules: { password: rules.newPassword },
    submit: async ({ password }) => {
      await api.resetPassword({ newPassword: password, token });
      setDone(true);
    },
  });

  if (done) {
    return (
      <AuthCard title="密码已重置" footer={<Link to="/signin">去登录</Link>}>
        <Notice tone="ok">密码已重置，请用新密码登录。</Notice>
      </AuthCard>
    );
  }
  if (!token) {
    return (
      <AuthCard title="重置密码" footer={<Link to="/forgot">重新申请</Link>}>
        <Notice tone="warn">{messageFor("invalid_token")}</Notice>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="重置密码" lead="设置一个新密码。" footer={<Link to="/signin">回到登录</Link>}>
      <FormBody form={form} submitLabel="重置密码">
        <Field label="新密码" hint="至少 10 位" error={form.errors.password}>
          <input type="password" autoComplete="new-password" {...form.bind("password")} />
        </Field>
      </FormBody>
    </AuthCard>
  );
}

export function Loading() {
  return (
    <main className="auth-page">
      <p className="muted" role="status">正在加载…</p>
    </main>
  );
}

export function LoadFailed({ onRetry }) {
  return (
    <AuthCard title="暂时连不上服务">
      <Notice tone="warn">{messageFor("network_error")}</Notice>
      <Btn variant="primary" className="auth-submit" onClick={onRetry}>重试</Btn>
    </AuthCard>
  );
}
