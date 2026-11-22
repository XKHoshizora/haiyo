// @vitest-environment jsdom
// The composite group avatar at every size the app draws it: its members' boxes stay inside its own box.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StoreProvider } from "../src/data/store.jsx";
import { GroupAvatar } from "../src/ui/primitives.jsx";
import { emptyState } from "../src/data/store.jsx";

afterEach(cleanup);

describe("GroupAvatar", () => {
  it("every member is drawn no larger than the picture and is placed by the stylesheet's rules for its count (no inline placing), at every size the app uses", () => {
    for (const size of [32, 44, 46, 48, 56, 64, 84]) {
      for (const n of [2, 3, 4]) {
        const ids = Array.from({ length: n }, (_, i) => `m${i}`);
        const { container, unmount } = render(
          <StoreProvider initialState={emptyState()}>
            <GroupAvatar ids={ids} size={size} />
          </StoreProvider>,
        );
        const box = container.querySelector(".group-avatar");
        expect(box.className).toContain(`n${n}`);
        expect(box.style.width).toBe(`${size}px`);
        const members = [...box.querySelectorAll(":scope > .avatar")];
        expect(members).toHaveLength(n);
        for (const m of members) {
          expect(parseFloat(m.style.width)).toBeLessThanOrEqual(size);
          expect(m.style.transform).toBe("");
          expect(m.style.margin).toBe("");
          expect(m.style.left + m.style.top + m.style.right + m.style.bottom).toBe("");
        }
        unmount();
      }
    }
  });
});
