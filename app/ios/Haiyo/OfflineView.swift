import UIKit

/// The cannot-connect screen: a symbol, a title, one line, and 重试.
final class OfflineView: UIView {
    var onRetry: (() -> Void)?

    private let symbol = UIImageView()
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let retryButton = UIButton(configuration: .filled())

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(named: "LaunchBackground") ?? .systemBackground

        symbol.image = UIImage(systemName: "wifi.exclamationmark")
        symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .regular)
        symbol.tintColor = .secondaryLabel
        symbol.contentMode = .scaleAspectFit
        symbol.isAccessibilityElement = false

        titleLabel.font = .preferredFont(forTextStyle: .title3)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = .label
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        titleLabel.accessibilityTraits = .header

        messageLabel.font = .preferredFont(forTextStyle: .body)
        messageLabel.adjustsFontForContentSizeCategory = true
        messageLabel.textColor = .secondaryLabel
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0

        retryButton.configuration?.title = "重试"
        retryButton.configuration?.cornerStyle = .capsule
        retryButton.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 28, bottom: 10, trailing: 28)
        retryButton.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [symbol, titleLabel, messageLabel, retryButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(24, after: messageLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Centred when it fits; scrolls at the largest text sizes so the title and 重试 stay reachable. It stays inside
        // the safe area on every side (the Duo's status column is on the right when closed) and below the corners
        // (the iPad window controls): vertical corner adaptation keeps the full width of a narrow window.
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        addSubview(scroll)
        scroll.addSubview(stack)
        let content = scroll.contentLayoutGuide
        let frame = scroll.frameLayoutGuide
        let fill = content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor)
        let area = layoutGuide(for: .safeArea(cornerAdaptation: .vertical))
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: area.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: area.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: area.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: area.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            fill,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -24),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ failure: LoadFailure) {
        titleLabel.text = failure.title
        messageLabel.text = failure.message
        accessibilityViewIsModal = true
    }
}
