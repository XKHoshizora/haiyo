import UIKit
import XCTest
@testable import Haiyo

/// The samples are what UIKit reported on the iOS 27.2 simulators (iPhone Duo, iPad Pro 13-inch), 2026-11-23.
final class PageLayoutTests: XCTestCase {
    private func insets(_ t: CGFloat, _ l: CGFloat, _ b: CGFloat, _ r: CGFloat) -> NSDirectionalEdgeInsets {
        NSDirectionalEdgeInsets(top: t, leading: l, bottom: b, trailing: r)
    }

    private var duoClosed: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 466, height: 678),
                     safe: insets(0, 0, 34, 84), cornerHorizontal: insets(0, 2, 34, 84), cornerVertical: insets(17, 0, 34, 84),
                     occlusions: [CGRect(x: 400, y: 29, width: 37, height: 37), CGRect(x: 382, y: 0, width: 84, height: 174)])
    }

    private func duoOpen(fold: Bool) -> LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 951, height: 669),
                     safe: insets(0, 0, 34, 84), cornerHorizontal: insets(0, 16, 34, 84), cornerVertical: insets(16, 0, 34, 84),
                     divisions: fold ? [CGRect(x: 456, y: 0, width: 40, height: 669)] : [],
                     occlusions: [CGRect(x: 867, y: 0, width: 84, height: 124)])
    }

    private var duoLaptop: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 669, height: 951),
                     safe: insets(82, 0, 34, 0), cornerHorizontal: insets(82, 16, 34, 16), cornerVertical: insets(82, 0, 34, 0),
                     divisions: [CGRect(x: 0, y: 456, width: 669, height: 40)],
                     occlusions: [CGRect(x: 525, y: 0, width: 144, height: 82)])
    }

    private var iPadFullScreen: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 1032, height: 1376),
                     safe: insets(32, 0, 20, 0), cornerHorizontal: insets(32, 10, 20, 10), cornerVertical: insets(32, 0, 20, 0),
                     occlusions: [CGRect(x: 0, y: 0, width: 1032, height: 32)])
    }

    private var iPadWindow: LayoutSample {
        LayoutSample(bounds: CGRect(x: 0, y: 0, width: 402, height: 675),
                     safe: insets(10, 0, 10, 0), cornerHorizontal: insets(10, 66, 10, 10), cornerVertical: insets(53, 0, 10, 0),
                     occlusions: [CGRect(x: 0, y: 0, width: 1032, height: 32), CGRect(x: 21, y: 21, width: 41, height: 22)])
    }

    func testTheFoldIsReportedOnlyWhilePartlyOpen() {
        XCTAssertNil(LayoutGeometry.layout(duoClosed).fold)
        XCTAssertNil(LayoutGeometry.layout(duoOpen(fold: false)).fold, "fully open: the division is inactive")
        XCTAssertEqual(LayoutGeometry.layout(duoOpen(fold: true)).fold,
                       PageLayout.Fold(axis: .vertical, x: 456, y: 0, width: 40, height: 669))
        XCTAssertEqual(LayoutGeometry.layout(duoLaptop).fold,
                       PageLayout.Fold(axis: .horizontal, x: 0, y: 456, width: 669, height: 40))
        XCTAssertNil(LayoutGeometry.layout(iPadWindow).fold)
    }

    func testTheFoldIsInCSSPixelsOfTheLayoutViewport() {
        let zoomed = LayoutGeometry.layout(duoOpen(fold: true), zoom: 2)
        XCTAssertEqual(zoomed.fold, PageLayout.Fold(axis: .vertical, x: 228, y: 0, width: 20, height: 335))
        let below = LayoutGeometry.layout(duoLaptop, obscured: UIEdgeInsets(top: 50, left: 0, bottom: 0, right: 0))
        XCTAssertEqual(below.fold?.y, 406)
        var odd = duoOpen(fold: true)
        odd.divisions = [CGRect(x: 455.5, y: 0, width: 40.2, height: 669)]
        XCTAssertEqual(LayoutGeometry.layout(odd).fold, PageLayout.Fold(axis: .vertical, x: 455, y: 0, width: 41, height: 669),
                       "whole pixels that cover the band")
        var outside = duoOpen(fold: true)
        outside.divisions = [CGRect(x: 2000, y: 0, width: 40, height: 669)]
        XCTAssertNil(LayoutGeometry.layout(outside).fold, "a region outside the view")
    }

    func testTheCornerIsWhatTheCornersNeedBeyondTheSafeArea() {
        XCTAssertEqual(LayoutGeometry.layout(duoClosed).corner, PageLayout.Corner(top: 17, leading: 2, trailing: 0))
        XCTAssertEqual(LayoutGeometry.layout(duoOpen(fold: false)).corner, PageLayout.Corner(top: 16, leading: 16, trailing: 0))
        XCTAssertEqual(LayoutGeometry.layout(iPadFullScreen).corner, PageLayout.Corner(top: 0, leading: 10, trailing: 10))
        XCTAssertEqual(LayoutGeometry.layout(iPadWindow).corner, PageLayout.Corner(top: 43, leading: 66, trailing: 10),
                       "the window controls")
    }

    /// Only the iPad window controls move a page that does not handle `layout`; the Duo's cameras and status column
    /// and the iPad's status bar lie inside the safe area's insets.
    func testOnlyTheWindowControlsKeepAnUnawarePageDown() {
        XCTAssertEqual(LayoutGeometry.windowControlsTop(iPadWindow), 53)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(iPadFullScreen), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(duoClosed), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(duoOpen(fold: true)), 0)
        XCTAssertEqual(LayoutGeometry.windowControlsTop(duoLaptop), 0)
        var turning = duoLaptop
        turning.occlusions = [CGRect(x: 585, y: 0, width: 84, height: 124)]
        XCTAssertEqual(LayoutGeometry.windowControlsTop(turning), 0, "the status column mid-rotation, on the trailing side")
    }

    func testRightToLeftWindowControlsAreOnTheRight() {
        var window = iPadWindow
        window.occlusions = [CGRect(x: 340, y: 21, width: 41, height: 22)]
        XCTAssertEqual(LayoutGeometry.windowControlsTop(window), 0, "left-to-right: that is the trailing corner")
        window.isRightToLeft = true
        XCTAssertEqual(LayoutGeometry.windowControlsTop(window), 53)
    }

    func testTheDetailThePageReceives() {
        let none = PageLayout().json
        XCTAssertTrue(none["fold"] is NSNull)
        XCTAssertEqual(none["corner"] as? [String: Int], ["top": 0, "leading": 0, "trailing": 0])
        let folded = LayoutGeometry.layout(duoOpen(fold: true)).json
        XCTAssertEqual(folded["fold"] as? [String: AnyHashable],
                       ["axis": "vertical", "x": 456, "y": 0, "width": 40, "height": 669])
    }
}
