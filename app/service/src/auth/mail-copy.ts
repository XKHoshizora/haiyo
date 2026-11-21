import { PRODUCT_NAME } from "../brand.ts";
import { renderMailHtml } from "./mail-html.ts";

/** How long each mailed link works; Better Auth's `expiresIn` settings (auth.ts) and the mail text both read these. */
export const VERIFY_EMAIL_TTL_SECONDS = 24 * 60 * 60;
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

/** A mail is two parts that say the same: the plain text (`body`) and an HTML version (`html`, src/auth/mail-html.ts). */
export interface MailCopy {
  subject: string;
  body: string;
  html: string;
}

const IGNORE_LINE = "如果这不是你本人的操作，请忽略这封邮件。";
/**
 * The verification mail's version of IGNORE_LINE: someone may register an address that is not theirs, and following
 * the link would confirm that account (and the password they chose) as the address owner's.
 */
const NOT_REGISTERED_LINE = `如果你没有注册 ${PRODUCT_NAME}，请不要点击链接，直接忽略这封邮件。`;

/** "24 小时", "1 小时", "30 分钟": the lifetime in the unit people say it in. */
function validFor(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function verifyEmailMail(url: string): MailCopy {
  const subject = `验证你的 ${PRODUCT_NAME} 邮箱`;
  const welcome = `欢迎来到 ${PRODUCT_NAME}。`;
  const lifetime = `链接 ${validFor(VERIFY_EMAIL_TTL_SECONDS)}内有效。`;
  return {
    subject,
    body: ["你好，", `${welcome}请点击下面的链接，确认这个邮箱属于你：`, url, lifetime, NOT_REGISTERED_LINE].join("\n"),
    html: renderMailHtml({
      title: subject,
      preheader: welcome,
      heading: "验证你的邮箱",
      paragraphs: [welcome, "点一下下面的按钮，确认这个邮箱属于你。"],
      button: { label: "验证邮箱", url },
      ...(url ? { fallbackUrl: url } : {}),
      lifetime,
      notYou: NOT_REGISTERED_LINE,
    }),
  };
}

/** To the owner of a verified account, when someone tries to register its address again (nothing was changed). */
export function registrationAttemptMail(signInLink: string, resetLink: string): MailCopy {
  const subject = `有人尝试用你的邮箱注册 ${PRODUCT_NAME}`;
  const news = `刚刚有人尝试用这个邮箱注册 ${PRODUCT_NAME}。`;
  const nothing = "这个邮箱已经有账号了，所以没有创建新账号，你的账号也没有任何变化。";
  return {
    subject,
    body: ["你好，", `${news}${nothing}`, "如果是你本人，请直接登录：", signInLink, "如果忘记了密码，可以在这里重置：", resetLink, IGNORE_LINE].join("\n"),
    html: renderMailHtml({
      title: subject,
      preheader: news,
      heading: "有人尝试用你的邮箱注册",
      paragraphs: [news, nothing, "如果是你本人，请直接登录。"],
      button: { label: "去登录", url: signInLink },
      links: [{ lead: "如果忘记了密码，可以在这里重置：", url: resetLink }],
      ...(signInLink ? { fallbackUrl: signInLink } : {}),
      notYou: IGNORE_LINE,
    }),
  };
}

export function resetPasswordMail(link: string): MailCopy {
  const subject = `重置你的 ${PRODUCT_NAME} 密码`;
  const asked = `我们收到了重置你 ${PRODUCT_NAME} 账号密码的请求。`;
  const lifetime = `链接 ${validFor(RESET_PASSWORD_TTL_SECONDS)}内有效，且只能使用一次。`;
  return {
    subject,
    body: ["你好，", `${asked}请点击下面的链接设置新密码：`, link, lifetime, IGNORE_LINE].join("\n"),
    html: renderMailHtml({
      title: subject,
      preheader: asked,
      heading: "重置你的密码",
      paragraphs: [asked, "点一下下面的按钮，设置新密码。"],
      button: { label: "设置新密码", url: link },
      ...(link ? { fallbackUrl: link } : {}),
      lifetime,
      notYou: IGNORE_LINE,
    }),
  };
}
