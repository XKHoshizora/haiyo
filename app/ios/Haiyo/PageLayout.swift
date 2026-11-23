import UIKit

/// The shape of the page's window that the web cannot see for itself, as the shell tells it (`haiyo:layout`, and
/// `layout` in the `hello` reply). CSS px of the web view's layout viewport, origin at its top-left.
struct PageLayout: Equatable {
    /// The Duo's fold while the device is partly open (a band the page should keep its content out of); nil when
    /// there is none, or when the device is closed or fully open.
    var fold: Fold?
    /// Room the window's corners need beyond `env(safe-area-inset-*)`: the iPad window controls, rounded display
    /// corners. The page adds it to whatever sits in a corner (the rail's first item, a header's back button).
    var corner = Corner()

    struct Fold: Equatable {
        /// `vertical`: a book-style fold between a left and a right half; `horizontal`: laptop-style, top and bottom.
        var axis: Axis
        var x: Int
        var y: Int
        var width: Int
        var height: Int
    }

    enum Axis: String { case vertical, horizontal }

    struct Corner: Equatable {
        var top = 0
        var leading = 0
        var trailing = 0
    }

    /// The `detail` the page receives (`fold` is `null` when there is none).
    var json: [String: Any] {
        [
            "fold": fold.map { ["axis": $0.axis.rawValue, "x": $0.x, "y": $0.y, "width": $0.width, "height": $0.height] as [String: Any] } ?? NSNull(),
            "corner": ["top": corner.top, "leading": corner.leading, "trailing": corner.trailing],
        ]
    }
}

/// What UIKit reports about the web view's window, in the web view's coordinates (points).
struct LayoutSample: Equatable {
    var bounds: CGRect
    /// The plain safe area — what WebKit gives the page as `env(safe-area-inset-*)` (measured: equal on the Duo and
    /// on iPad, full screen and windowed).
    var safe = NSDirectionalEdgeInsets.zero
    /// The safe area with corners adapted horizontally (`leading`/`trailing` grow) and vertically (`top` grows).
    var cornerHorizontal = NSDirectionalEdgeInsets.zero
    var cornerVertical = NSDirectionalEdgeInsets.zero
    /// Active division regions (the fold; iOS 27.1 and later, empty before).
    var divisions: [CGRect] = []
    /// The iPad idiom (from the view's trait collection): only iPad scenes have window controls.
    var isPad = false
}

enum LayoutGeometry {
    /// The page's layout for a sample. `zoom` is the web view's `pageZoom`; `obscured` its `obscuredContentInsets`
    /// (they move and scale the layout viewport against the view). Values describe the unzoomed layout viewport: a
    /// pinch zoom does not change them.
    static func layout(_ sample: LayoutSample, zoom: CGFloat = 1, obscured: UIEdgeInsets = .zero) -> PageLayout {
        let scale = zoom.isFinite && zoom > 0 ? zoom : 1
        var layout = PageLayout()
        let fold = sample.divisions.lazy
            .filter { isFinite($0) }
            .map { ($0, $0.intersection(sample.bounds)) }
            .first { _, band in !band.isNull && !band.isEmpty }
        if let fold, isFinite(obscured) {
            let (frame, band) = fold
            if let minX = whole(((band.minX - obscured.left) / scale).rounded(.down)),
               let minY = whole(((band.minY - obscured.top) / scale).rounded(.down)),
               let maxX = whole(((band.maxX - obscured.left) / scale).rounded(.up)),
               let maxY = whole(((band.maxY - obscured.top) / scale).rounded(.up)) {
                layout.fold = PageLayout.Fold(
                    // The direction of the whole region, not of the part inside the view.
                    axis: frame.height >= frame.width ? .vertical : .horizontal,
                    x: minX, y: minY, width: maxX - minX, height: maxY - minY
                )
            }
        }
        let extra = { (adapted: CGFloat, plain: CGFloat) -> Int in
            let points = adapted - plain
            guard points.isFinite, points > 0 else { return 0 }
            return whole((points / scale).rounded(.up)) ?? 0
        }
        layout.corner = PageLayout.Corner(
            top: extra(sample.cornerVertical.top, sample.safe.top),
            leading: extra(sample.cornerHorizontal.leading, sample.safe.leading),
            trailing: extra(sample.cornerHorizontal.trailing, sample.safe.trailing)
        )
        return layout
    }

    /// The least extra a top corner must need before it counts as a window control: measured extras are 0–18 pt for
    /// rounded corners (Duo 16–18, iPad 0 at the top) and 43 pt for the iPad window controls, and fractions must not
    /// count.
    static let windowControlsMinimumExtra: CGFloat = 24

    /// For a page that does not handle `layout` yet: how far to keep it below the iPad window controls, in points
    /// (`obscuredContentInsets.top`), or 0. On iPad, the vertically corner-adapted safe area reaches well below the plain
    /// one exactly when a window control is in a top corner (measured: 0 full screen in either orientation, 43 more in
    /// a window), on iPadOS 26.0 and later, whichever side the controls are on. Phones never: the Duo's rounded corners
    /// give a corner extra too (16–18 pt), and that must not push its page down.
    static func windowControlsTop(_ sample: LayoutSample) -> CGFloat {
        guard sample.isPad else { return 0 }
        let top = sample.cornerVertical.top
        guard top.isFinite, sample.safe.top.isFinite, top - sample.safe.top >= windowControlsMinimumExtra else { return 0 }
        return top
    }

    /// A whole number for the page, or nil for a value no screen has (non-finite, or beyond ±1 000 000).
    private static func whole(_ x: CGFloat) -> Int? {
        guard x.isFinite, abs(x) <= 1_000_000 else { return nil }
        return Int(x)
    }

    private static func isFinite(_ r: CGRect) -> Bool {
        r.origin.x.isFinite && r.origin.y.isFinite && r.size.width.isFinite && r.size.height.isFinite
    }

    private static func isFinite(_ i: UIEdgeInsets) -> Bool {
        i.top.isFinite && i.left.isFinite && i.bottom.isFinite && i.right.isFinite
    }
}

/// The shell's layout bookkeeping, apart from UIKit: which layout the page has, whether the shell holds an unaware page
/// below the window controls, and when an event goes out. The view controller applies each `Output`.
struct LayoutState {
    struct Output: Equatable {
        /// `obscuredContentInsets.top` for the web view.
        var obscuredTop: CGFloat
        /// A `haiyo:layout` to send, or nil.
        var event: PageLayout?
    }

    private(set) var sample: LayoutSample?
    /// The page listed `layout` in a `hello` whose answer was delivered.
    private(set) var pageHandlesLayout = false
    /// The last layout the page received (event or `hello` answer).
    private(set) var sent: PageLayout?
    var zoom: CGFloat = 1

    var obscuredTop: CGFloat {
        guard !pageHandlesLayout, let sample else { return 0 }
        return LayoutGeometry.windowControlsTop(sample)
    }

    /// The layout as a page that handles `layout` sees it (the shell no longer holds it down): what `hello` answers.
    var layoutForHello: PageLayout {
        sample.map { LayoutGeometry.layout($0, zoom: zoom) } ?? PageLayout()
    }

    /// The geometry settled.
    mutating func settled(_ sample: LayoutSample) -> Output {
        self.sample = sample
        return output()
    }

    /// A new document committed, or the content process died: the page handles nothing until its `hello` is answered.
    mutating func pageChanged() -> Output {
        pageHandlesLayout = false
        sent = nil
        return output()
    }

    /// A `hello` answer reached the page that asked; `replied` is the `layout` it carried (nil when not listed).
    mutating func helloDelivered(events: Set<String>, replied: PageLayout?) -> Output {
        pageHandlesLayout = events.contains("layout")
        sent = pageHandlesLayout ? replied : nil
        return output()
    }

    private mutating func output() -> Output {
        let top = obscuredTop
        guard pageHandlesLayout, let sample else { return Output(obscuredTop: top, event: nil) }
        let current = LayoutGeometry.layout(sample, zoom: zoom)
        guard current != sent else { return Output(obscuredTop: top, event: nil) }
        sent = current
        return Output(obscuredTop: top, event: current)
    }
}

/// A transparent view over the web view that reports the window's shape whenever it may have changed. UIKit runs
/// `updateConstraints()` again when the reserved regions read there change (the fold has no notification); size and
/// safe-area changes ask for it too.
final class LayoutObserverView: UIView {
    var onChange: ((LayoutSample) -> Void)?
    private var lastSize = CGSize.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override class var requiresConstraintBasedLayout: Bool { true }

    override func updateConstraints() {
        onChange?(sample())
        super.updateConstraints()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != lastSize else { return }
        lastSize = bounds.size
        setNeedsUpdateConstraints()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsUpdateConstraints()
    }

    private func sample() -> LayoutSample {
        var sample = LayoutSample(
            bounds: bounds,
            safe: directionalEdgeInsets(for: .safeArea()),
            cornerHorizontal: directionalEdgeInsets(for: .safeArea(cornerAdaptation: .horizontal)),
            cornerVertical: directionalEdgeInsets(for: .safeArea(cornerAdaptation: .vertical)),
            isPad: traitCollection.userInterfaceIdiom == .pad
        )
        if #available(iOS 27.1, *) {
            sample.divisions = reservedRegions(kind: .division).map(\.frame)
        }
        return sample
    }
}
