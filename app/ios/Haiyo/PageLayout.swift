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
    /// Active division regions (the fold) and active occlusions (cameras, the status column, the window controls).
    var divisions: [CGRect] = []
    var occlusions: [CGRect] = []
    var isRightToLeft = false
}

enum LayoutGeometry {
    /// The page's layout for a sample. `zoom` is the web view's `pageZoom`; `obscured` its `obscuredContentInsets`
    /// (they move and scale the layout viewport against the view).
    static func layout(_ sample: LayoutSample, zoom: CGFloat = 1, obscured: UIEdgeInsets = .zero) -> PageLayout {
        let scale = zoom > 0 ? zoom : 1
        var layout = PageLayout()
        if let band = sample.divisions.map({ $0.intersection(sample.bounds) }).first(where: { !$0.isNull && !$0.isEmpty }) {
            let minX = Int(((band.minX - obscured.left) / scale).rounded(.down))
            let minY = Int(((band.minY - obscured.top) / scale).rounded(.down))
            let maxX = Int(((band.maxX - obscured.left) / scale).rounded(.up))
            let maxY = Int(((band.maxY - obscured.top) / scale).rounded(.up))
            layout.fold = PageLayout.Fold(
                axis: band.height >= band.width ? .vertical : .horizontal,
                x: minX, y: minY, width: maxX - minX, height: maxY - minY
            )
        }
        let extra = { (adapted: CGFloat, plain: CGFloat) in Int((max(0, adapted - plain) / scale).rounded(.up)) }
        layout.corner = PageLayout.Corner(
            top: extra(sample.cornerVertical.top, sample.safe.top),
            leading: extra(sample.cornerHorizontal.leading, sample.safe.leading),
            trailing: extra(sample.cornerHorizontal.trailing, sample.safe.trailing)
        )
        return layout
    }

    /// For a page that does not handle `layout` yet: how far to keep it below the iPad window controls, in points
    /// (`obscuredContentInsets.top`), or 0. The controls are an active occlusion in the top-leading corner that reaches
    /// into the plain safe area; the Duo's cameras and status column, and the iPad's status bar, lie inside the safe
    /// area's insets (measured), so they never move the page.
    static func windowControlsTop(_ sample: LayoutSample) -> CGFloat {
        let b = sample.bounds
        let s = sample.safe
        let safeRect = CGRect(
            x: b.minX + (sample.isRightToLeft ? s.trailing : s.leading),
            y: b.minY + s.top,
            width: b.width - s.leading - s.trailing,
            height: b.height - s.top - s.bottom
        )
        let controls = sample.occlusions.filter { region in
            let leadingHalf = sample.isRightToLeft ? region.midX > b.midX : region.midX < b.midX
            return leadingHalf && region.midY < b.midY && region.intersects(safeRect)
        }
        guard let bottom = controls.map(\.maxY).max() else { return 0 }
        return max(bottom, sample.cornerVertical.top) - b.minY
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
            isRightToLeft: effectiveUserInterfaceLayoutDirection == .rightToLeft
        )
        if #available(iOS 27.1, *) {
            sample.divisions = reservedRegions(kind: .division).map(\.frame)
            sample.occlusions = reservedRegions(kind: .occlusion).map(\.frame)
        }
        return sample
    }
}
