// A box that changes size after it was laid out — a picture's, a video's, once their own dimensions are known — asks the message list to keep a list
// that was at its newest message there (pages/ChatView.jsx `keepNewestInView`, handed down by `GrowContext`); scrolled up, nothing moves. One hook for
// every media body: pictures and players grow the same way.
import { useContext, useLayoutEffect } from "react";
import { GrowContext } from "./ImageViewer.jsx";

/** Call with the box's width and height (undefined while it is not known): once for every change of box. */
export function useGrowOnSize(width, height) {
  const grew = useContext(GrowContext);
  useLayoutEffect(() => {
    if (width) grew?.();
  }, [width, height]);
}
