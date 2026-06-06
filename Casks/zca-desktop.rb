cask "zca-desktop" do
  version "0.1.6"
  sha256 "9ecc20284ad2494cdd43460b2d7ee47c8907fd7b7d25263aa7f3552df6d2d679"

  url "https://github.com/tuanle96/zca-desktop/releases/download/v#{version}/Zalo.Desktop_#{version}_universal.dmg"
  name "Zalo Desktop"
  desc "Unofficial personal-use Zalo desktop client"
  homepage "https://github.com/tuanle96/zca-desktop"

  depends_on macos: :big_sur

  app "Zalo Desktop.app"

  zap trash: [
    "~/Library/Application Support/app.zca.desktop",
    "~/Library/Caches/app.zca.desktop",
    "~/Library/HTTPStorages/app.zca.desktop",
    "~/Library/Preferences/app.zca.desktop.plist",
    "~/Library/Saved Application State/app.zca.desktop.savedState",
    "~/Library/WebKit/app.zca.desktop",
  ]
end
