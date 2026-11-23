p = 'src/ui/ModelMarks.jsx'
s = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
s = s.replace('\r\n', '\n')
a = s.index('import { Eye')
b = s.index('/** A list narrower than this')
new = '''import { AudioLines, Clapperboard, Eye, FileText, ImagePlus, Lightbulb, Video, Volume2, Wrench } from "../icons.js";

/** Money: text at every width, first, and about money, not an ability. */
export const PRICE_TEXT = { free: "免费", paid: "需余额" };

/**
 * The marks of a model, one vocabulary wherever a model is listed (the picker, the provider page): money first, then what
 * the model can do, each with an icon and a short word, in the order of this table.
 *
 * THE RULE: a mark is shown only when the product actually does that with the model. A mark must never promise what the
 * product does not do, so every kind the product may one day pass to or from a model is reserved here now (its label, its
 * accessible name and its icon fixed) with `shown: false`: never rendered, never in the legend. When the product does it,
 * the row's `shown` becomes true (and the service carries the field `from` reads); nothing else changes.
 *
 * A row: `kind` (its key and column), `text` (the short word, also its accessible name), `title` (the whole sentence),
 * `Icon`, `from(model)` (whether the model has it; `model`: an object of the fields the service reports, any of them absent),
 * `shown`. Today the wire carries `vision`, `reasoning` (a boolean here), `tools` and `pdf`; `audioIn`, `videoIn`, `imageOut`,
 * `videoOut` and `audioOut` are the names the service will carry.
 */
export const ABILITIES = [
  { kind: "vision", text: "看图", title: "能看图片", Icon: Eye, from: (m) => m.vision === true, shown: true },
  { kind: "reasoning", text: "思考", title: "支持思考", Icon: Lightbulb, from: (m) => m.reasoning === true, shown: true },
  { kind: "tools", text: "工具", title: "会用工具（查聊天记录、看文件）", Icon: Wrench, from: (m) => m.tools !== false, shown: true },
  // Reserved (the product passes no such content to or from a model yet; a PDF goes as it is, but the owner wants no chip for it).
  { kind: "audioIn", text: "听语音", title: "能听语音", Icon: AudioLines, from: (m) => m.audioIn === true, shown: false },
  { kind: "videoIn", text: "看视频", title: "能看视频", Icon: Video, from: (m) => m.videoIn === true, shown: false },
  { kind: "pdf", text: "读 PDF", title: "能直接读 PDF", Icon: FileText, from: (m) => m.pdf === true, shown: false },
  { kind: "imageOut", text: "画图", title: "能画图", Icon: ImagePlus, from: (m) => m.imageOut === true, shown: false },
  { kind: "videoOut", text: "生成视频", title: "能生成视频", Icon: Clapperboard, from: (m) => m.videoOut === true, shown: false },
  { kind: "audioOut", text: "生成语音", title: "能生成语音", Icon: Volume2, from: (m) => m.audioOut === true, shown: false },
];
/** The rows that are shown now (read at the time of use, so one flipped on is drawn at once). */
export const shownAbilities = () => ABILITIES.filter((a) => a.shown);
/** The columns in order: the money's, then each shown ability's. */
export const columnOrder = () => ["price", ...shownAbilities().map((a) => a.kind)];

/** The shown ability kinds `model` has (an object of the service's fields, any absent), in table order. */
export const abilityMarks = (model) => shownAbilities().filter((a) => a.from(model)).map((a) => a.kind);

/** The kinds in `marks` in column order (a row's marks, or what a legend must explain); a kind not shown is dropped. */
export const markKinds = (marks = []) => columnOrder().flatMap((col) => (col === "price" ? marks.filter((m) => m in PRICE_TEXT).slice(0, 1) : marks.includes(col) ? [col] : []));
/** The words of `marks`, in order. */
export const markWords = (marks) => markKinds(marks).map((kind) => PRICE_TEXT[kind] ?? ABILITIES.find((a) => a.kind === kind).text);

'''
s = s[:a] + new + s[b:]
s = s.replace('const cols = columns ? COLUMNS.filter((c) => columns.includes(c))', 'const cols = columns ? columnOrder().filter((c) => columns.includes(c))')
s = s.replace('const shown = ABILITIES.filter((a) => kinds.includes(a.kind));', 'const shown = shownAbilities().filter((a) => kinds.includes(a.kind));')
open(p, 'w', encoding='utf8', newline='').write(s.replace('\n', nl))

p = 'src/pages/ModelSelect.jsx'
s = open(p, encoding='utf8', newline='').read()
s = s.replace('import { COLUMNS, MarksLegend', 'import { MarksLegend').replace('PRICE_TEXT, markKinds, markWords, useMarksMode', 'PRICE_TEXT, columnOrder, markKinds, markWords, useMarksMode').replace('const columns = COLUMNS.filter(', 'const columns = columnOrder().filter(')
open(p, 'w', encoding='utf8', newline='').write(s)

p = 'src/icons.js'
s = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'
for name, before in [('AudioLines', 'ArrowLeft,'), ('Clapperboard', 'Clock,'), ('ImagePlus', 'Info,'), ('Video', 'Users,'), ('Volume2', 'X,')]:
    pass
s = s.replace('  ArrowLeft,' + nl, '  ArrowLeft,' + nl + '  AudioLines,' + nl, 1)
s = s.replace('  Clock,' + nl, '  Clapperboard,' + nl + '  Clock,' + nl, 1)
s = s.replace('  Info,' + nl, '  ImagePlus,' + nl + '  Info,' + nl, 1)
s = s.replace('  Wrench,' + nl, '  Video,' + nl + '  Volume2,' + nl + '  Wrench,' + nl, 1)
open(p, 'w', encoding='utf8', newline='').write(s)
