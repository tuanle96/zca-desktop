cask "zca-desktop" do
  version "0.1.1"
  sha256 "19e515806182f1e1e9dd8c631c6fc14474dd8574645cb3d047b685981b9aca16"

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
