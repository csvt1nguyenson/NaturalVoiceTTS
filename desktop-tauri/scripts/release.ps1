# Phát hành phiên bản mới lên GitHub Releases kèm latest.json cho auto-update.
# Dùng: npm run release -- -Notes "Mô tả thay đổi"
param([string]$Notes = "Cập nhật NaturalVoice")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$conf = Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json
$version = $conf.version
$endpoint = $conf.plugins.updater.endpoints[0]
if ($endpoint -match "github.com/([^/]+)/([^/]+)/") { $owner = $Matches[1]; $repo = $Matches[2] } else { throw "Endpoint updater chưa đúng dạng GitHub." }

Write-Host "== Build v$version =="
Set-Location $root\..\app; npm run build:css | Out-Null; Set-Location $root
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri-keys\naturalvoice.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build thất bại" }

$dir = "src-tauri\target\release\bundle\nsis"
$exe = Get-ChildItem $dir -Filter "*_x64-setup.exe" | Select-Object -First 1
$sig = Get-Content "$($exe.FullName).sig" -Raw
$latest = @{
  version = $version
  notes = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{ "windows-x86_64" = @{ signature = $sig.Trim(); url = "https://github.com/$owner/$repo/releases/download/v$version/$($exe.Name)" } }
}
$latestPath = Join-Path $dir "latest.json"
[IO.File]::WriteAllText((Resolve-Path $dir).Path + "\latest.json", ($latest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))

Write-Host "== Tag & push =="
git add -A; git commit -m "Release v$version" --allow-empty | Out-Null
git tag -f "v$version"; git push origin main; git push -f origin "v$version"

Write-Host "== GitHub Release =="
try { gh release delete "v$version" --yes 2>$null } catch {}
gh release create "v$version" $exe.FullName $latestPath --title "NaturalVoice v$version" --notes $Notes
Write-Host "Xong: https://github.com/$owner/$repo/releases/tag/v$version"
