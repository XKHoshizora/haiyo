import { vi } from "vitest";

// The avatar adjust dialog decodes and encodes pictures with a canvas, which jsdom does not have: every test sees the stand-in
// (tests/avatar-fake.js). It is mocked here, before anything imports the real module; the arithmetic is tested for real in
// tests/avatar-crop.test.js.
vi.mock("../src/ui/avatarImage.js", () => import("./avatar-fake.js"));

// The signed-in application is a lazy chunk (src/App.jsx). Tests that render <App> load it up front, so it is
// ready the moment React asks for it and fake timers never wait on a module being read from disk.
if (typeof document !== "undefined") await import("../src/AppShell.jsx");

// An Agent's text turns rich at an animation frame (src/ui/markdownView.jsx `inFrame`). In tests a frame is the next
// microtask, so a text is rich as soon as its answer has arrived and nothing waits on a clock; the tests of the frames
// themselves (tests/markdown-view.test.jsx) turn a clock of their own by hand.
if (typeof document !== "undefined") {
  const { setFrameClock } = await import("../src/ui/markdownView.jsx");
  setFrameClock((run) => queueMicrotask(run));
}
// A reply being written is revealed at animation frames (src/ui/reveal.js). In tests a frame is a 16 ms timer that
// tells the time by Date.now(), so a suite with fake timers (and a fake Date) moves the reveal on as it moves its clock;
// tests/stream-reveal.test.jsx turns frames by hand.
if (typeof document !== "undefined") {
  const { setRevealFrames } = await import("../src/ui/reveal.js");
  setRevealFrames({ request: (run) => setTimeout(() => run(Date.now()), 16), cancel: (id) => clearTimeout(id) });
}
