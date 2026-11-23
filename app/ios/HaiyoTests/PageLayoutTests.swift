import UIKit
import XCTest
@testable import Haiyo

/// The samples are what UIKit reported on the iOS 27.2 simulators (iPhone Duo, iPad Pro 13-inch), 2026-11-23. The
/// corner-adapted insets are fractional there (17.3 shows as 18 in the page); the samples use whole points unless a
/// test is about rounding.
final class PageLayoutTests: XCTestCase {
    static func insets(_ t: CGFloat, _ l: CGFloat, _ b: CGFloat, _ r: CGFloat) -> NSDirectionalEdgeInsets {
        NSDirectionalEdgeInsets(top: t, leading: l, bottom: b, trailing: r)
    }

    static var duoClosed: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 466, height: 678),
                     safe: insets(0, 0, 34, 84), cornerHorizontal: insets(0, 2, 34, 84), cornerVertical: insets(17, 0, 34, 84))
    }

    static func duoOpen(fold: Bool) -> LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 951, height: 669),
                     safe: insets(0, 0, 34, 84), cornerHorizontal: insets(0, 16, 34, 84), cornerVertical: insets(16, 0, 34, 84),
                     divisions: fold ? [CGRect(x: 456, y: 0, width: 40, height: 669)] : [])
    }

    static var duoLaptop: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 669, height: 951),
                     safe: insets(82, 0, 34, 0), cornerHorizontal: insets(82, 16, 34, 16), cornerVertical: insets(82, 0, 34, 0),
                     divisions: [CGRect(x: 0, y: 456, width: 669, height: 40)])
    }

    static var iPadFullScreen: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 1032, height: 1376),
                     safe: insets(32, 0, 20, 0), cornerHorizontal: insets(32, 10, 20, 10), cornerVertical: insets(32, 0, 20, 0),
                     isPad: true)
    }

    /// A window: the controls in the top-leading corner. The same numbers come before iPadOS 27.1 (no reserved regions
    /// are read for this).
    static var iPadWindow: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 402, height: 675),
                     safe: insets(10, 0, 10, 0), cornerHorizontal: insets(10, 66, 10, 10), cornerVertical: insets(53, 0, 10, 0),
                     isPad: true)
    }

    private typealias T = PageLayoutTests

    // MARK: Geometry

    func testTheFoldIsReportedOnlyWhilePartlyOpen() {
        XCTAssertNil(LayoutGeometry.layout(T.duoClosed).fold)
        XCTAssertNil(LayoutGeometry.layout(T.duoOpen(fold: false)).fold, "fully open: the division is inactive")
        XCTAssertEqual(LayoutGeometry.layout(T.duoOpen(fold: true)).fold,
                       PageLayout.Fold(axis: .vertical, x: 456, y: 0, width: 40, height: 669))
        XCTAssertEqual(LayoutGeometry.layout(T.duoLaptop).fold,
                       PageLayout.Fold(axis: .horizontal, x: 0, y: 456, width: 669, height: 40))
        XCTAssertNil(LayoutGeometry.layout(T.iPadWindow).fold)
    }

    func testTheFoldIsInCSSPixelsOfTheLayoutViewport() {
        let zoomed = LayoutGeometry.layout(T.duoOpen(fold: true), zoom: 2)
        XCTAssertEqual(zoomed.fold, PageLayout.Fold(axis: .vertical, x: 228, y: 0, width: 20, height: 335))
        let below = LayoutGeometry.layout(T.duoLaptop, obscured: UIEdgeInsets(top: 50, left: 0, bottom: 0, right: 0))
        XCTAssertEqual(below.fold?.y, 406)
        var odd = T.duoOpen(fold: true)
        odd.divisions = [CGRect(x: 455.5, y: 0, width: 40.2, height: 669)]
        XCTAssertEqual(LayoutGeometry.layout(odd).fold, PageLayout.Fold(axis: .vertical, x: 455, y: 0, width: 41, height: 669),
                       "whole pixels that cover the band (the simulator's fold reaches the page as x 455, width 41)")
        var outside = T.duoOpen(fold: true)
        outside.divisions = [CGRect(x: 2000, y: 0, width: 40, height: 669)]
        XCTAssertNil(LayoutGeometry.layout(outside).fold, "a region outside the view")
    }

    /// The direction is the whole region's, not that of the part inside the view.
    func testAPartlyVisibleFoldKeepsItsDirection() {
        var clipped = T.duoOpen(fold: true)
        clipped.divisions = [CGRect(x: 456, y: -660, width: 40, height: 669)]
        XCTAssertEqual(LayoutGeometry.layout(clipped).fold, PageLayout.Fold(axis: .vertical, x: 456, y: 0, width: 40, height: 9))
    }

    /// Values UIKit should never report do not crash the shell: no fold, no corner.
    func testNonFiniteValuesGiveNothing() {
        var broken = T.duoOpen(fold: true)
        broken.divisions = [CGRect(x: CGFloat.nan, y: 0, width: 40, height: 669)]
        broken.cornerVertical.top = .infinity
        broken.cornerHorizontal.leading = .nan
        let layout = LayoutGeometry.layout(broken, zoom: .nan)
        XCTAssertNil(layout.fold)
        XCTAssertEqual(layout.corner, PageLayout.Corner(top: 0, leading: 0, trailing: 0))
        XCTAssertNil(LayoutGeometry.layout(T.duoOpen(fold: true), obscured: UIEdgeInsets(top: .nan, left: 0, bottom: 0, right: 0)).fold)
        var pad = T.iPadWindow
        pad.cornerVertical.top = .nan
        XCTAssertEqual(LayoutGeometry.windowControlsTop(pad), 0)
    }

    func testTheCornerIsWhatTheCornersNeedBeyondTheSafeArea() {
        XCTAssertEqual(LayoutGeometry.layout(T.duoClosed).corner, PageLayout.Corner(top: 17, leading: 2, trailing: 0))
        XCTAssertEqual(LayoutGeometry.layout(T.duoOpen(fold: false)).corner, PageLayout.Corner(top: 16, leading: 16, trailing: 0))
        XCTAssertEqual(LayoutGeometry.layout(T.iPadFullScreen).corner, PageLayout.Corner(top: 0, leading: 10, trailing: 10))
        XCTAssertEqual(LayoutGeometry.layout(T.iPadWindow).corner, PageLayout.Corner(top: 43, leading: 66, trailing: 10),
                       "the window controls")
    }

    /// Fractional points round up, so the page never gets less room than the corner needs (the Duo's 17.3 → 18).
    func testFractionalCornersRoundUp() {
        var duo = T.duoClosed
        duo.cornerVertical.top = 17.33
        duo.cornerHorizontal.leading = 2.33
        XCTAssertEqual(LayoutGeometry.layout(duo).corner, PageLayout.Corner(top: 18, leading: 3, trailing: 0))
    }

    /// Only an iPad's window controls move a page that does not handle `layout`; a phone never (the Duo's rounded
    /// corners give a corner extra too). The rule reads no reserved regions, so it holds before iPadOS 27.1 as well,
    /// and whichever side the controls are on.
    func testOnlyIPadWindowControlsKeepAnUnawarePageDown() {
        XCTAssertEqual(LayoutGeometry.windowControlsTop(T.iPadWindow), 53)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(T.iPadFullScreen), 0)
        var landscape = T.iPadFullScreen
        landscape.bounds = CGRect(x: 0, y: 0, width: 1376, height: 1032)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(landscape), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(T.duoClosed), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(T.duoOpen(fold: true)), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(T.duoLaptop), 0)
        var phoneLikeAWindow = T.iPadWindow
        phoneLikeAWindow.isPad = false
        XCTAssertEqual(LayoutGeometry.windowControlsTop(phoneLikeAWindow), 0, "the phone idiom never")
    }

    func testTheDetailThePageReceives() {
        let none = PageLayout().json
        XCTAssertTrue(none["fold"] is NSNull)
        XCTAssertEqual(none["corner"] as? [String: Int], ["top": 0, "leading": 0, "trailing": 0])
        let folded = LayoutGeometry.layout(T.duoOpen(fold: true)).json
        XCTAssertEqual(folded["fold"] as? [String: AnyHashable],
                       ["axis": "vertical", "x": 456, "y": 0, "width": 40, "height": 669])
    }
}

/// The shell's layout bookkeeping: stopgap on and off, events only when something changed.
final class LayoutStateTests: XCTestCase {
    private typealias T = PageLayoutTests
    private let noEvent: PageLayout? = nil

    func testAnUnawarePageIsKeptBelowTheWindowControlsAndHearsNothing() {
        var state = LayoutState()
        XCTAssertEqual(state.settled(T.iPadWindow), .init(obscuredTop: 53, event: noEvent))
        XCTAssertEqual(state.helloDelivered(events: ["pause", "resume"], replied: nil), .init(obscuredTop: 53, event: noEvent),
                       "a hello without layout changes nothing")
        XCTAssertEqual(state.settled(T.iPadFullScreen), .init(obscuredTop: 0, event: noEvent), "full screen: no stopgap")
        XCTAssertEqual(state.settled(T.iPadWindow), .init(obscuredTop: 53, event: noEvent))
    }

    func testAPageThatHandlesLayoutGetsTheWholeViewAndOnlyChanges() {
        var state = LayoutState()
        _ = state.settled(T.iPadWindow)
        let replied = state.layoutForHello
        XCTAssertEqual(replied.corner.top, 43, "hello answers with what the page will see without the stopgap")
        XCTAssertEqual(state.helloDelivered(events: ["layout"], replied: replied), .init(obscuredTop: 0, event: noEvent),
                       "delivered: the stopgap goes; the answer already carried the value")
        XCTAssertEqual(state.settled(T.iPadWindow), .init(obscuredTop: 0, event: noEvent), "unchanged: nothing sent")
        let full = state.settled(T.iPadFullScreen)
        XCTAssertEqual(full.obscuredTop, 0)
        XCTAssertEqual(full.event?.corner, PageLayout.Corner(top: 0, leading: 10, trailing: 10))
        XCTAssertEqual(state.settled(T.iPadFullScreen).event, noEvent)
    }

    func testAnOlderHelloValueIsCorrectedAtDelivery() {
        var state = LayoutState()
        _ = state.settled(T.iPadWindow)
        let replied = state.layoutForHello
        _ = state.settled(T.iPadFullScreen)
        let delivered = state.helloDelivered(events: ["layout"], replied: replied)
        XCTAssertEqual(delivered.event?.corner.top, 0, "the window changed between the answer and its delivery")
    }

    func testANewPageOrACrashStartsOver() {
        var state = LayoutState()
        _ = state.settled(T.iPadWindow)
        _ = state.helloDelivered(events: ["layout"], replied: state.layoutForHello)
        XCTAssertEqual(state.pageChanged(), .init(obscuredTop: 53, event: noEvent), "the stopgap is back until the new page's hello")
        XCTAssertEqual(state.settled(T.iPadFullScreen).event, noEvent, "the new page has not asked")
        XCTAssertEqual(state.helloDelivered(events: ["layout"], replied: state.layoutForHello).event, noEvent)
    }

    func testTheDuoIsNeverHeldDownAndItsFoldIsSent() {
        var state = LayoutState()
        XCTAssertEqual(state.settled(T.duoClosed).obscuredTop, 0)
        _ = state.helloDelivered(events: ["layout"], replied: state.layoutForHello)
        let open = state.settled(T.duoOpen(fold: true))
        XCTAssertEqual(open.obscuredTop, 0)
        XCTAssertEqual(open.event?.fold?.axis, .vertical)
        let flat = state.settled(T.duoOpen(fold: false))
        XCTAssertNotNil(flat.event, "fully open: the fold goes")
        XCTAssertNil(flat.event?.fold)
    }

    func testNoGeometryYet() {
        var state = LayoutState()
        XCTAssertEqual(state.helloDelivered(events: ["layout"], replied: state.layoutForHello), .init(obscuredTop: 0, event: noEvent))
        XCTAssertEqual(state.layoutForHello, PageLayout())
    }
}
