cask "zca-desktop" do
  version "0.1.2"
  sha256 "0a99c9b816053d75909798f50cce58d3a678f269b7adfb12ccf3467323bd3647"

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
