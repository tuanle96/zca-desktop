cask "zca-desktop" do
  version "0.1.5"
  sha256 "dbb2403f4573e970c6c81360c27cec8e14a4a749c7664be07e7cef9efefa0508"

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
